import { ipcMain, dialog, BrowserWindow } from 'electron';
import { basename, dirname, join } from 'path';
import { promises as fsPromises, realpathSync } from 'fs';
import { relativePosix } from '../utils/pathHelpers';
import {
  readDirectoryTree,
  createFolder,
  renameItem,
  deleteItem,
  readFileWithCoherentStat,
  VaultTooLargeError,
  VaultTreeTooLargeError,
  CaseRenameStrandedError,
} from '../vault/fileOps';
import { atomicWriteFile, uniqueFolderPath, LOCK_AWARE_SUPPRESS_MS } from '../vault/filenameUtils';
import { FileWatcher } from '../services/fileWatcher';
import {
  assertWithinVault,
  assertSafeRelativePath,
  assertSafeFilename,
  assertNotInFiloDir,
} from '../utils/pathSecurity';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { clearApprovedSources } from '../services/approvedSources';
import { logMainError } from '../utils/mainLogger';
import {
  assertPayloadByteSize,
  PAYLOAD_LIMITS,
} from '../utils/payloadLimits';
import {
  loadPreferences,
  setOpenLastVaultOnLaunch,
  loadRecentVaults,
  addRecentVault,
  removeRecentVault,
  pinRecentVault,
  clearRecentVaults,
} from '../services/recentVaults';
import { vaultRegistry } from '../services/vaultRegistry';
import { ipcErrorCode } from './ipcErrorCode';
import { noteReadEncoding, isRegisteredNonUtf8, renameNonUtf8 } from '../services/nonUtf8Registry';

let activeWatcher: FileWatcher | null = null;
let currentVaultRoot: string | null = null;

/** The typed refusal for a write over a non-UTF-8 file. */
function notUtf8Refusal(relativePath: string): { success: false; code: 'NOT_UTF8'; error: string } {
  return {
    success: false,
    code: 'NOT_UTF8',
    error: `"${relativePath}" is not UTF-8 text; Filo won't overwrite it (use "Convert to UTF-8")`,
  };
}

export function getVaultRoot(): string | null {
  return currentVaultRoot;
}

export function getActiveWatcher(): FileWatcher | null {
  return activeWatcher;
}

/**
 * Stops the active watcher during a graceful shutdown so its reconcile timer
 * and OS-level file handle are released before `app.exit()`. Otherwise
 * fs.watch's deferred close emits "watcher emitting after window destroyed"
 * warnings and (on Windows) briefly holds the vault directory open.
 */
export async function stopActiveWatcher(): Promise<void> {
  if (!activeWatcher) return;
  const w = activeWatcher;
  activeWatcher = null;
  try {
    await w.stop();
  } catch (err) {
    logMainError('shutdown.stopActiveWatcher', err);
  }
}

/**
 * Registers all vault-related IPC handlers.
 */
export function registerVaultHandlers(): void {
  /**
   * Opens a native folder picker and returns the selected path (or null).
   */
  ipcMain.handle('vault:select', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Vault Folder',
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /**
   * Reads the full file tree of the vault directory.
   *
   * The node cap is applied DURING the walk, so pointing Filo at `~` / `C:\`
   * aborts within bounded memory; `VaultTooLargeError` is surfaced as a
   * `vault:tree-too-large` event so the sidebar can toast.
   *
   * Returns `{ ok: true, tree }` or `{ ok: false, code, error? }` — a failed
   * scan must not look like an empty vault.
   */
  ipcMain.handle('vault:read-tree', async (_event, vaultPath: string) => {
    try {
      assertActiveVault(vaultPath);
      const tree = await readDirectoryTree(vaultPath);
      return { ok: true, tree };
    } catch (err) {
      if (err instanceof VaultTooLargeError) {
        logMainError('vault:read-tree', err);
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('vault:tree-too-large', { vaultPath, limit: err.limit });
        }
        return { ok: false, code: 'too-large' as const, error: String(err) };
      }
      if (err instanceof VaultTreeTooLargeError) {
        // "Too many serialized bytes" rather than "too many entries"; both
        // surface the same vault:tree-too-large toast.
        logMainError('vault:read-tree', err);
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('vault:tree-too-large', { vaultPath, limit: err.limit });
        }
        return { ok: false, code: 'too-large' as const, error: String(err) };
      }
      logMainError('vault:read-tree', err);
      const code = ipcErrorCode(err);
      return { ok: false, code, error: String(err) };
    }
  });

  /**
   * Creates a new folder inside the vault.
   *
   * `vaultRoot` is gated by `assertActiveVault`, so a stale (post-swap)
   * vault root is rejected before the containment check.
   */
  ipcMain.handle('vault:create-folder', async (_event, vaultRoot: string, folderPath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertWithinVault(vaultRoot, folderPath);
      // Per-segment safety guard: rejects depth overrun, separators, `..`,
      // and Windows-illegal chars / reserved DOS names. `forCreation`
      // enforces the Win-only rules on every platform so a Mac user can't
      // seed a folder that breaks Windows.
      const relPath = relativePosix(vaultRoot, folderPath);
      assertSafeRelativePath(relPath, { forCreation: true });
      // Refuse mkdir inside `.filo/` via the generic
      // channel; dedicated config/tags/templates handlers own that dir.
      assertNotInFiloDir(relPath);
      await createFolder(folderPath);
      return { success: true };
    } catch (err) {
      logMainError('vault:create-folder', err);
      return { success: false, code: ipcErrorCode(err), error: String(err) };
    }
  });

  /**
   * Returns the next free folder name inside `parentPath` derived from
   * `baseName` — e.g. "New Folder" → "New Folder (2)" if "New Folder"
   * already exists. Used by the vault sidebar's "+ New Folder" flow so
   * the rename input pre-fills with a non-colliding default.
   */
  ipcMain.handle(
    'vault:suggest-folder-name',
    async (_event, vaultRoot: string, parentPath: string, baseName: string) => {
      try {
        assertActiveVault(vaultRoot);
        assertWithinVault(vaultRoot, parentPath);
        const fullPath = await uniqueFolderPath(parentPath, baseName);
        return { success: true, name: basename(fullPath) };
      } catch (err) {
        logMainError('vault:suggest-folder-name', err);
        return { success: false, code: ipcErrorCode(err), error: String(err) };
      }
    },
  );

  /**
   * Renames a file or folder.
   */
  ipcMain.handle('vault:rename', async (_event, vaultRoot: string, oldPath: string, newPath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertWithinVault(vaultRoot, oldPath);
      assertWithinVault(vaultRoot, newPath);
      // Refuse both src and dest inside `.filo/`: renaming out would let the
      // renderer exfiltrate config; renaming in would let it overwrite.
      assertNotInFiloDir(relativePosix(vaultRoot, oldPath));
      assertNotInFiloDir(relativePosix(vaultRoot, newPath));
      // Validate the NEW basename (portable on every platform). The OLD
      // basename intentionally isn't — a POSIX file legitimately named
      // `2025:01:15.md` must still rename.
      assertSafeFilename(basename(newPath), { forCreation: true });
      // Bracket renameItem with watcher suppression so the in-app rename
      // doesn't echo back as a `vault:file-renamed` external event and run
      // the whole rename cascade a second time (idempotent, but costs a
      // sentinel write + dirty-flush per descendant on a folder rename).
      const oldRel = relativePosix(vaultRoot, oldPath);
      const newRel = relativePosix(vaultRoot, newPath);
      let oldIsDirectory = false;
      try {
        const stat = await fsPromises.stat(oldPath);
        oldIsDirectory = stat.isDirectory();
      } catch {
        // ENOENT or permission error — fall through to renameItem, which
        // surfaces the failure to the renderer. No suppression needed
        // because there's nothing on disk to emit events for.
      }
      if (activeWatcher) {
        const suppressFn = (rel: string) => {
          if (!rel || rel === '..' || rel.startsWith('../')) return;
          if (oldIsDirectory) {
            activeWatcher!.suppressTree(rel, 5000);
          } else {
            activeWatcher!.suppress(rel, LOCK_AWARE_SUPPRESS_MS);
          }
        };
        suppressFn(oldRel);
        suppressFn(newRel);
      }
      await renameItem(oldPath, newPath);
      renameNonUtf8(oldPath, newPath); // the non-UTF-8 write refusal follows the file
      // Post-rename re-suppress: the OS may emit the create-side event
      // moments after `renameItem` resolves on slow disks, especially for
      // recursive folder moves. Bracketing both sides keeps the
      // suppression window tight to the operation rather than relying on
      // a single up-front 2/5 s budget.
      if (activeWatcher) {
        const suppressFn = (rel: string) => {
          if (!rel || rel === '..' || rel.startsWith('../')) return;
          if (oldIsDirectory) {
            activeWatcher!.suppressTree(rel, 5000);
          } else {
            activeWatcher!.suppress(rel, LOCK_AWARE_SUPPRESS_MS);
          }
        };
        suppressFn(oldRel);
        suppressFn(newRel);
      }
      return { success: true };
    } catch (err) {
      // Case-rename stranded: include the temp path so the renderer toast
      // can name where the file ended up (recoverable, not lost).
      if (err instanceof CaseRenameStrandedError) {
        logMainError('vault:rename', err);
        return {
          success: false,
          code: 'IO_ERROR' as const,
          error: err.message,
          strandedAt: err.strandedAt,
        };
      }
      const code = ipcErrorCode(err);
      // ENOENT is recoverable: the renderer's tree snapshot was stale
      // (file moved/deleted outside Filo). The caller toasts + refreshes
      // the tree — no need for a stack trace in the main-process log.
      // TARGET_EXISTS is a routine UX path — the renderer
      // surfaces a confirm prompt, no main-side stack trace needed.
      if (code !== 'ENOENT' && code !== 'TARGET_EXISTS') {
        logMainError('vault:rename', err);
      } else if (code === 'ENOENT') {
        console.warn('vault:rename ENOENT — source no longer exists:', oldPath);
      }
      return { success: false, code, error: String(err) };
    }
  });

  /**
   * Deletes a file or folder.
   *
   * The unlink is bracketed with watcher suppression so a user-initiated
   * folder delete doesn't show a dirty editor beneath it a "deleted
   * externally" prompt. The 5s window covers unlink latency plus the 300ms
   * watcher debounce on slow disks.
   */
  ipcMain.handle('vault:delete', async (_event, vaultRoot: string, itemPath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertWithinVault(vaultRoot, itemPath);
      // Block generic deletes inside `.filo/` except the allowlisted
      // crash-recovery sentinels, whose cleanup flows through this channel.
      assertNotInFiloDir(relativePosix(vaultRoot, itemPath));
      // Pre-stat the path so we know whether to suppress as a single
      // entry (file) or a tree prefix (folder). Suppression has to
      // happen BEFORE the unlink so events that fire during the delete
      // are dropped — calling suppress after the fact is racy.
      const rel = relativePosix(vaultRoot, itemPath);
      let isDirectory = false;
      try {
        const stat = await fsPromises.stat(itemPath);
        isDirectory = stat.isDirectory();
      } catch {
        // ENOENT or permission error — fall through to deleteItem,
        // which treats ENOENT as success. No suppression needed since
        // there's nothing to emit events for.
      }
      if (rel && activeWatcher) {
        if (isDirectory) {
          activeWatcher.suppressTree(rel, 5000);
        } else {
          activeWatcher.suppress(rel, LOCK_AWARE_SUPPRESS_MS);
        }
      }
      await deleteItem(itemPath);
      return { success: true };
    } catch (err) {
      logMainError('vault:delete', err);
      return { success: false, code: ipcErrorCode(err), error: String(err) };
    }
  });

  /**
   * Starts watching a vault folder for changes.
   *
   * Does NOT register a vault: `vault:init-config` is the single registration
   * authority and must already have made `vaultPath` active. Otherwise a
   * compromised renderer could anchor the active vault at an arbitrary host
   * directory (`~/.ssh`, …) and read/write it through every
   * `assertActiveVault`-gated handler.
   *
   * The `fs.stat` directory check is kept as defence: the vault could have
   * been deleted on disk between init-config and watch.
   */
  // `lastReconcileAt` is shared with the `vault:reconcile`
  // handler below (one per-process throttle) and reset to 0 on a vault swap so
  // the post-swap focus reconcile isn't dropped by the OUTGOING vault's window.
  const RECONCILE_THROTTLE_MS = 5000;
  let lastReconcileAt = 0;
  ipcMain.handle('vault:watch', async (_event, vaultPath: string) => {
    try {
      if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
        throw new Error('vaultPath must be a non-empty string');
      }
      // Require the open-vault handshake: `vault:init-config` must have
      // already registered `vaultPath` as the active vault. Throws
      // `NoActiveVaultError` when no vault is open or the path doesn't
      // match — `vault:watch` is not a registration vector.
      assertActiveVault(vaultPath);
      // TOCTOU guard: this handler awaits twice and then re-arms the
      // registry and starts a watcher. A `vault:close` or swap landing in
      // either await would be silently reversed (re-arming a STALE vault and
      // failing every gated write of the new one). Capture the registry
      // epoch (bumped on every `setCurrentVault`, so a same-path
      // close→reopen is caught too) and bail after each await on mismatch.
      const epochAtStart = vaultRegistry.epoch;
      const assertEpochUnchanged = (): void => {
        if (vaultRegistry.epoch !== epochAtStart) {
          throw new Error(
            'vault registration changed while starting the watcher — stale vault:watch aborted',
          );
        }
      };
      const stat = await fsPromises.stat(vaultPath);
      if (!stat.isDirectory()) {
        throw new Error('vaultPath is not a directory');
      }
      assertEpochUnchanged();

      if (activeWatcher) {
        // Await so the OLD vault's in-flight walk can't emit late events
        // under the NEW vault's listener.
        await activeWatcher.stop();
        // A close/swap may have landed during the stop await.
        assertEpochUnchanged();
      }
      // Canonicalise via `realpathSync` once so the same
      // resolved path drives the local `currentVaultRoot`, the watcher,
      // and the registry. A user-picked symlink (`/Users/me/vault` →
      // `/Volumes/Drive/vault`) collapses to one canonical form here.
      let canonical = vaultPath;
      try {
        canonical = realpathSync.native ? realpathSync.native(vaultPath) : realpathSync(vaultPath);
      } catch {
        // realpath failed (race with deletion etc.) — fall through with
        // the input path; the watcher start will surface the real error.
      }
      currentVaultRoot = canonical;
      // Vault is changing: drop copy-sources approved (dialog / OS drop)
      // under the PRIOR vault. Registration runs post-open, so this
      // vault's own picks survive. Pairs with the vault:close clear below.
      clearApprovedSources();
      // Mirror to the cross-window vault registry so the popout sidebar
      // window can synchronously read the active vault path on startup.
      vaultRegistry.setCurrentVault(canonical);
      activeWatcher = new FileWatcher(canonical);
      activeWatcher.start();
      // Reset the reconcile throttle so the new vault's first focus-driven
      // reconcile isn't dropped because the OLD vault's ran < 5 s ago.
      lastReconcileAt = 0;
      return { success: true };
    } catch (err) {
      logMainError('vault:watch', err);
      return { success: false, code: ipcErrorCode(err), error: String(err) };
    }
  });

  /**
   * Triggers an on-demand reconciliation pass. The renderer calls this on
   * window-focus so missed events (typical on macOS/Windows when the
   * window has been backgrounded for a while) surface as soon as the user
   * tabs back in.
   *
   * Main-side 5 s throttle (matching the renderer's focus throttle): the
   * channel is reachable from anywhere in the renderer, and hammering it
   * would pin main on full vault walks. The throttle state is declared with
   * `vault:watch` so a vault swap can reset it.
   */
  /**
   * Closes the active vault: stops the watcher, drops the
   * registry pointer, and clears the local `currentVaultRoot`. Subsequent
   * IPC handlers gated by `assertActiveVault` will fail-closed until the
   * renderer opens a new vault via `vault:watch`. Idempotent — calling
   * with no active vault is a no-op success.
   *
   * Pairs with the renderer-side "Close vault" sidebar action so the user
   * can swap to a different vault without restarting the app.
   */
  ipcMain.handle('vault:close', async () => {
    try {
      if (activeWatcher) {
        await activeWatcher.stop();
        activeWatcher = null;
      }
      currentVaultRoot = null;
      vaultRegistry.setCurrentVault(null);
      lastReconcileAt = 0;
      clearApprovedSources(); // release this vault's approved copy sources too
      return { success: true };
    } catch (err) {
      logMainError('vault:close', err);
      return { success: false, code: ipcErrorCode(err), error: String(err) };
    }
  });

  ipcMain.handle('vault:reconcile', async () => {
    if (!activeWatcher) return { success: false, error: 'No active watcher' };
    const now = Date.now();
    if (now - lastReconcileAt < RECONCILE_THROTTLE_MS) {
      return { success: true, skipped: true };
    }
    lastReconcileAt = now;
    await activeWatcher.reconcileNow({ seedOnly: false });
    return { success: true };
  });

  /**
   * Reads a file's contents as UTF-8 text. Used by the renderer to read
   * .md file content when dropping markdown files onto a board, by the
   * vault index for full-text + metadata rebuilds, and by every sentinel
   * (dirty-flag, tag-rewrite, rename-cascade) recovery path.
   *
   * Canonical shape `(vaultRoot, relativePath)`:
   *   - `vaultRoot` is `assertActiveVault`-gated so a stale renderer
   *     handle can't read across vault swaps.
   *   - `relativePath` is `assertSafeRelativePath`-validated so each
   *     segment passes the Windows-reserved-name + control-char filter
   *     before being joined onto the vault root.
   */
  ipcMain.handle('vault:read-file-text', async (_event, vaultRoot: string, relativePath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relativePath);
      const abs = join(vaultRoot, relativePath);
      assertWithinVault(vaultRoot, abs);
      // Pre-read stat caps the read at PAYLOAD_LIMITS.MARKDOWN (25 MB); a
      // multi-GB `.md` would otherwise OOM main or the renderer. The
      // FILE_TOO_LARGE code lets the toast say "file too large".
      //
      // The helper pre-stats, reads, then post-stats. mtimeMs/size are only
      // returned when the two stats agree; if a write landed in the gap they
      // are withheld and the renderer skips seeding its drift baseline.
      const result = await readFileWithCoherentStat(abs, PAYLOAD_LIMITS.MARKDOWN);
      if ('tooLarge' in result) {
        return {
          success: false,
          code: 'FILE_TOO_LARGE' as const,
          error: `File is ${result.size} bytes; vault:read-file-text cap is ${PAYLOAD_LIMITS.MARKDOWN} bytes`,
        };
      }
      // Record (or clear) a non-UTF-8 file so the text write
      // channels refuse to overwrite it with U+FFFD-damaged text.
      noteReadEncoding(abs, result.encoding === 'utf-8');
      return {
        success: true,
        content: result.content,
        mtimeMs: result.mtimeMs,
        size: result.size,
        encoding: result.encoding,
      };
    } catch (err) {
      const code = ipcErrorCode(err);
      // ENOENT is an expected, recoverable case for callers like the
      // dirty-flag sentinel check that probe whether a file exists by
      // attempting a read. Skip the noisy stack trace; the caller still
      // gets `{ success: false }`.
      if (code !== 'ENOENT' && code !== 'NO_ACTIVE_VAULT') {
        logMainError('vault:read-file-text', err);
      }
      return { success: false, code, error: String(err) };
    }
  });

  /**
   * Returns true iff a vault-relative path resolves to an existing
   * filesystem entry. Cheap probe used by `boardCache.persistAddTile` to
   * decide whether seeding a backing `.md` file would clobber an existing
   * one (e.g. when a tile drops onto a board referencing a file already on
   * disk in a subfolder).
   */
  ipcMain.handle(
    'vault:file-exists',
    async (_event, vaultRoot: string, relativePath: string) => {
      try {
        assertActiveVault(vaultRoot);
        assertSafeRelativePath(relativePath);
        const fullPath = join(vaultRoot, relativePath);
        assertWithinVault(vaultRoot, fullPath);
        await fsPromises.access(fullPath);
        return true;
      } catch {
        return false;
      }
    },
  );

  /**
   * Returns the file's mtime + size so callers can detect external edits
   * between a read and a write (e.g. `syncTileMarkdown` refuses to clobber
   * one that landed in the gap).
   *
   * On any failure (missing file, EACCES, NO_ACTIVE_VAULT) returns
   * `{ success: false }`; the renderer treats this as "no baseline".
   */
  ipcMain.handle(
    'vault:stat',
    async (_event, vaultRoot: string, relativePath: string) => {
      try {
        assertActiveVault(vaultRoot);
        assertSafeRelativePath(relativePath);
        const fullPath = join(vaultRoot, relativePath);
        assertWithinVault(vaultRoot, fullPath);
        const stat = await fsPromises.stat(fullPath);
        return { success: true, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch (err) {
        const code = ipcErrorCode(err);
        if (code !== 'ENOENT' && code !== 'NO_ACTIVE_VAULT') {
          logMainError('vault:stat', err);
        }
        return { success: false, code };
      }
    },
  );

  /**
   * Writes text content to a file in the vault. Creates parent directories
   * if they don't exist. Used for creating/updating .md files.
   *
   * Writes atomically (tmp → rename) so a crash mid-write can never leave
   * a half-written file on disk. Mirrors the watcher-suppression model
   * used by `board:save`: bracket the write with a long pre-suppress and a
   * short post-suppress so the rename event (which can land 600ms+ after
   * `suppress()` was called on Windows due to atomic-write retry backoff)
   * never escapes the suppression window.
   *
   * @param vaultRoot - Vault root directory
   * @param relativePath - Path relative to vault root (e.g., "Notes.md" or "subfolder/Notes.md")
   * @param content - UTF-8 text content to write
   */
  ipcMain.handle(
    'vault:write-file-text',
    async (_event, vaultRoot: string, relativePath: string, content: string) => {
      try {
        assertActiveVault(vaultRoot);
        // Structural sanity (depth + per-segment) before path joining.
        // `forCreation: true` because this channel can create a NEW file;
        // enforce Win-only rules on every platform so vaults stay portable.
        assertSafeRelativePath(relativePath, { forCreation: true });
        // Refuse generic writes into `.filo/` except for the allowlisted
        // crash-recovery sentinels; dedicated channels own `.filo/` writes.
        assertNotInFiloDir(relativePath);
        // Cap the payload up front so the renderer gets a typed "file too
        // large" code instead of a generic write failure.
        assertPayloadByteSize(
          Buffer.byteLength(content, 'utf-8'),
          PAYLOAD_LIMITS.MARKDOWN,
          'vault:write-file-text',
        );
        const fullPath = join(vaultRoot, relativePath);
        assertWithinVault(vaultRoot, fullPath);
        if (isRegisteredNonUtf8(fullPath)) return notUtf8Refusal(relativePath);
        await fsPromises.mkdir(dirname(fullPath), { recursive: true });
        activeWatcher?.suppress(relativePath, LOCK_AWARE_SUPPRESS_MS);
        await atomicWriteFile(fullPath, content);
        activeWatcher?.suppress(relativePath, 1000);
        return { success: true, path: fullPath };
      } catch (err) {
        logMainError('vault:write-file-text', err);
        return { success: false, code: ipcErrorCode(err), error: String(err) };
      }
    },
  );

  /**
   * CREATE-EXCLUSIVE text write for brand-new `.md` seeds
   * (Kanban card / task / Task-List OS drop). Reserves the name with an
   * `O_EXCL` open (`'wx'`, case-insensitive on NTFS/APFS) and returns a typed
   * `EEXIST` instead of overwriting a user's existing file; the renderer bumps
   * to ` (n)` and retries. Watcher suppression runs only AFTER the name is ours,
   * so a losing attempt never masks a real external edit of the existing file.
   * Mirrors `copyFileToVault`'s reserve-then-replace.
   */
  ipcMain.handle(
    'vault:create-file-text',
    async (_event, vaultRoot: string, relativePath: string, content: string) => {
      try {
        assertActiveVault(vaultRoot);
        assertSafeRelativePath(relativePath, { forCreation: true });
        assertNotInFiloDir(relativePath);
        assertPayloadByteSize(
          Buffer.byteLength(content, 'utf-8'),
          PAYLOAD_LIMITS.MARKDOWN,
          'vault:create-file-text',
        );
        const fullPath = join(vaultRoot, relativePath);
        assertWithinVault(vaultRoot, fullPath);
        await fsPromises.mkdir(dirname(fullPath), { recursive: true });
        try {
          const placeholder = await fsPromises.open(fullPath, 'wx');
          await placeholder.close();
        } catch (openErr) {
          if ((openErr as NodeJS.ErrnoException).code === 'EEXIST') {
            // Expected outcome (the renderer bumps the name) — not an error log.
            return { success: false, code: 'EEXIST', error: 'file already exists' };
          }
          throw openErr;
        }
        activeWatcher?.suppress(relativePath, LOCK_AWARE_SUPPRESS_MS);
        try {
          await atomicWriteFile(fullPath, content);
        } catch (writeErr) {
          // Drop only OUR 0-byte placeholder so a retry can reuse the name.
          await fsPromises.unlink(fullPath).catch(() => undefined);
          throw writeErr;
        }
        activeWatcher?.suppress(relativePath, 1000);
        return { success: true, path: fullPath };
      } catch (err) {
        logMainError('vault:create-file-text', err);
        return { success: false, code: ipcErrorCode(err), error: String(err) };
      }
    },
  );

  /**
   * Writes text content to an EXISTING file in the vault. Fails with ENOENT
   * if the target file does not exist (does NOT create parent directories,
   * does NOT seed a new file).
   *
   * Used by editor write paths (TextTile, DocumentEditor, PropertiesPopup)
   * so that a dirty editor's 300ms debounce cannot resurrect a file the
   * user just deleted in OS Explorer / git checkout. Separate channel
   * rather than an "expectExisting" flag so file-creation call sites
   * (tile factory drops, kanban card creation) keep their existing
   * semantics without a behaviour flag the renderer can forget to set.
   */
  ipcMain.handle(
    'vault:write-existing-file-text',
    async (_event, vaultRoot: string, relativePath: string, content: string) => {
      try {
        assertActiveVault(vaultRoot);
        assertSafeRelativePath(relativePath);
        // Same `.filo/` guard as `vault:write-file-text`.
        assertNotInFiloDir(relativePath);
        assertPayloadByteSize(
          Buffer.byteLength(content, 'utf-8'),
          PAYLOAD_LIMITS.MARKDOWN,
          'vault:write-existing-file-text',
        );
        const fullPath = join(vaultRoot, relativePath);
        assertWithinVault(vaultRoot, fullPath);
        try {
          await fsPromises.stat(fullPath);
        } catch (statErr) {
          const code = ipcErrorCode(statErr);
          if (code === 'ENOENT') {
            return { success: false, code: 'ENOENT', error: 'file no longer exists' };
          }
          throw statErr;
        }
        // Never overwrite a file whose bytes aren't UTF-8 with text decoded
        // from them (every non-ASCII byte would become U+FFFD).
        if (isRegisteredNonUtf8(fullPath)) return notUtf8Refusal(relativePath);
        activeWatcher?.suppress(relativePath, LOCK_AWARE_SUPPRESS_MS);
        // `expectExisting` re-verifies the destination right
        // before the rename so a delete landing in the stat-precheck→rename
        // gap aborts (ENOENT) instead of resurrecting the file with stale
        // editor bytes. The pre-stat above still short-circuits the common
        // already-deleted case before staging a tmp.
        await atomicWriteFile(fullPath, content, { expectExisting: true });
        activeWatcher?.suppress(relativePath, 1000);
        return { success: true, path: fullPath };
      } catch (err) {
        logMainError('vault:write-existing-file-text', err);
        return { success: false, code: ipcErrorCode(err), error: String(err) };
      }
    },
  );

  /**
   * Returns the "open last vault on launch" preference. The preference lives
   * in the userData dir so it's reachable before any vault is open.
   */
  ipcMain.handle('vault:get-launch-preference', async () => {
    const preferences = await loadPreferences();
    return { openOnLaunch: preferences.openLastVaultOnLaunch };
  });

  /**
   * Persists the "open last vault on launch" toggle. Used by General Settings.
   */
  ipcMain.handle('vault:set-open-on-launch', async (_event, enabled: unknown) => {
    try {
      await setOpenLastVaultOnLaunch(enabled === true);
      return { success: true };
    } catch (err) {
      logMainError('preferences:set-open-last-vault', err);
      return { success: false, error: String(err) };
    }
  });

  // ── Recent vaults list ─────────────────────────────────────────────────
  // Lives in `userData/recent-vaults.json` (not in any vault) because the
  // list must be readable before any vault is open. Every mutation returns
  // the updated list so the renderer doesn't need a separate read.

  ipcMain.handle('vault:list-recents', async () => loadRecentVaults());

  // Defensive caps on every renderer-supplied string that lands in
  // `recent-vaults.json`. 4 KB covers every legitimate vault path (POSIX
  // PATH_MAX is 4096); the null-byte check stops an embedded NUL from
  // truncating a path inside downstream `path.*` helpers.
  const MAX_RECENT_PATH_LEN = 4096;
  const MAX_RECENT_NAME_LEN = 4096;
  const isSafeRecentString = (s: string, max: number): boolean =>
    s.length > 0 && s.length <= max && !s.includes('\0');

  ipcMain.handle('vault:add-recent', async (_event, path: unknown, name: unknown) => {
    // Typed `{ ok, recents }` envelope: a bare `[]` on failure would be
    // indistinguishable from an empty list, and the renderer would wipe the
    // displayed recents on a transient stat failure (e.g. a network share
    // briefly offline). The read-only sibling channels keep a bare array.
    if (typeof path !== 'string' || typeof name !== 'string') {
      return { ok: false, code: 'INVALID_ARG', error: 'add-recent requires a string path and name' };
    }
    if (!isSafeRecentString(path, MAX_RECENT_PATH_LEN)) {
      return { ok: false, code: 'INVALID_ARG', error: 'vault path is empty, too long, or contains a null byte' };
    }
    if (!isSafeRecentString(name, MAX_RECENT_NAME_LEN)) {
      return { ok: false, code: 'INVALID_ARG', error: 'vault name is empty, too long, or contains a null byte' };
    }
    // Confirm the path is an existing directory before persisting it, so a
    // typo / deleted folder / file path never lands in the recent list.
    try {
      const stat = await fsPromises.stat(path);
      if (!stat.isDirectory()) {
        return { ok: false, code: 'NOT_A_DIRECTORY', error: `not a directory: ${path}` };
      }
    } catch (err) {
      return { ok: false, code: 'ENOENT', error: String(err) };
    }
    return { ok: true, recents: await addRecentVault(path, name) };
  });

  ipcMain.handle('vault:remove-recent', async (_event, path: unknown) => {
    if (typeof path !== 'string') return [];
    if (!isSafeRecentString(path, MAX_RECENT_PATH_LEN)) return [];
    return removeRecentVault(path);
  });

  ipcMain.handle('vault:pin-recent', async (_event, path: unknown, pinned: unknown) => {
    if (typeof path !== 'string') return [];
    if (!isSafeRecentString(path, MAX_RECENT_PATH_LEN)) return [];
    return pinRecentVault(path, pinned === true);
  });

  ipcMain.handle('vault:clear-recents', async () => clearRecentVaults());
}
