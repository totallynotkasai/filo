import { ipcMain, dialog, BrowserWindow } from 'electron';
import { basename, dirname, join } from 'path';
import { promises as fsPromises, realpathSync } from 'fs';
import { toPosix, relativePosix } from '../utils/pathHelpers';
import {
  readDirectoryTree,
  createFolder,
  renameItem,
  deleteItem,
  copyFileToVault,
  readFileContents,
  VaultTooLargeError,
  VaultTreeTooLargeError,
  RenameTargetExistsError,
  CaseRenameStrandedError,
} from '../vault/fileOps';
import { atomicWriteFile, uniqueFolderPath } from '../vault/filenameUtils';
import { FileWatcher } from '../services/fileWatcher';
import {
  assertWithinVault,
  assertSafeRelativePath,
  assertSafeFilename,
  assertNotInFiloDir,
  FiloDirForbiddenError,
} from '../utils/pathSecurity';
import { assertActiveVault, NoActiveVaultError } from '../utils/activeVaultCheck';
import { logMainError } from '../utils/mainLogger';
import {
  assertPayloadByteSize,
  PAYLOAD_LIMITS,
  PayloadTooLargeError,
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

/**
 * Maps a Node fs error to a stable, renderer-friendly error code. Renderer
 * callers shouldn't have to string-match `err.message` to distinguish
 * "file does not exist" from "I/O error" or "permission denied".
 *
 * `NO_ACTIVE_VAULT` takes precedence so handlers gated by `assertActiveVault`
 * can return a single combined code through this helper.
 */
function ipcErrorCode(err: unknown): 'NO_ACTIVE_VAULT' | 'FILE_TOO_LARGE' | 'INVALID_FILENAME' | 'FORBIDDEN' | 'TARGET_EXISTS' | 'ENOENT' | 'EACCES' | 'ENOSPC' | 'IO_ERROR' {
  if (err instanceof NoActiveVaultError) return 'NO_ACTIVE_VAULT';
  if (err instanceof PayloadTooLargeError) return 'FILE_TOO_LARGE';
  // Phase 1 / 1.2 — generic vault channels can't write to `.filo/`. The
  // FORBIDDEN code lets the renderer tell "the OS refused" from "your
  // caller asked us to do something it isn't allowed to do".
  if (err instanceof FiloDirForbiddenError) return 'FORBIDDEN';
  // Phase 1 / 1.1 — `RenameTargetExistsError` surfaces from the
  // `renameItem` pre-flight on POSIX so the renderer can prompt for
  // overwrite confirmation rather than silently losing the destination
  // file. Windows already returns EEXIST/EPERM through the generic
  // `EACCES` branch below, but the dedicated code is clearer for the
  // dominant prompt-flow case (POSIX).
  if (err instanceof RenameTargetExistsError) return 'TARGET_EXISTS';
  // Phase 31 A3.6 — surface assertSafeFilename rejections (Windows
  // reserved names, control chars, path separators) as a distinct code
  // so the renderer's rename-fail toast can mention the rule instead of
  // the generic "rename failed" copy.
  if (err instanceof Error && /^Unsafe filename rejected/.test(err.message)) {
    return 'INVALID_FILENAME';
  }
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'TARGET_EXISTS') return 'TARGET_EXISTS';
  // Windows-side rename collision: `fs.rename` surfaces EEXIST when the
  // destination exists and EPERM in some directory cases. Translate
  // EEXIST through the dedicated code so the renderer prompt-flow shape
  // matches the POSIX path. EPERM stays in EACCES below — it can also
  // come from non-overwrite causes (locked file, antivirus hold) and
  // the renderer wouldn't know to prompt.
  if (code === 'EEXIST') return 'TARGET_EXISTS';
  if (code === 'ENOENT') return 'ENOENT';
  if (code === 'EACCES' || code === 'EPERM') return 'EACCES';
  // Phase 40 / 40.3 — distinguish disk-full from generic IO_ERROR so the
  // renderer's drag-drop toast can tell the user to free space rather
  // than offering an unhelpful "try again". `copyFileToVault` and
  // `atomicWriteFile` already preserve the partially-written tmp on
  // these codes; the dedicated code lets the toast surface that path.
  if (code === 'ENOSPC' || code === 'EIO' || code === 'ENOMEM') return 'ENOSPC';
  return 'IO_ERROR';
}

let activeWatcher: FileWatcher | null = null;
let currentVaultRoot: string | null = null;

/**
 * Maximum size, in bytes, of a single file copied into the vault via
 * `vault:copy-file`. Caps the renderer's ability to pull in extremely large
 * external files (e.g. multi-GB media someone dropped onto a board by
 * accident) before we hit a disk-full or atomic-write failure deep inside
 * `copyFileToVault`. 100 MB matches the Phase 6 destructive-undo cap order
 * of magnitude (25 MB) while leaving headroom for legitimate video imports.
 */
const VAULT_COPY_MAX_SIZE_BYTES = 100 * 1024 * 1024;

export function getVaultRoot(): string | null {
  return currentVaultRoot;
}

export function getActiveWatcher(): FileWatcher | null {
  return activeWatcher;
}

/**
 * Sprint A / A8 — stops the active watcher during a graceful shutdown so
 * its reconcile timer and OS-level file handle are released before
 * `app.exit()`. Without this, fs.watch's deferred-close behaviour leaves
 * Node emitting "watcher emitting after window destroyed" warnings on
 * quit and (on Windows) holds the vault directory open just long enough
 * to race with system services.
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
   * Phase 1 / 1.5 — the cap (`VAULT_TREE_MAX_NODES = 100_000`) is now
   * applied DURING the walk inside `readDirectoryTree`, not after. A user
   * who points Filo at `~` / `C:\` aborts within bounded memory instead
   * of building the whole tree first. The walker throws
   * `VaultTooLargeError`, which we surface to the renderer as a
   * `vault:tree-too-large` event so the sidebar can toast "vault too
   * large to scan" instead of silently showing an empty tree.
   *
   * D.2 — returns an envelope `{ ok: true, tree }` on success and
   * `{ ok: false, code, error? }` on failure. The pre-D.2 shape was a
   * bare `FileTreeNode[]` with `[]` overloaded to mean both "empty
   * vault" AND "scan failed" — the renderer had no way to surface a
   * toast for the failure case. The renderer destructures the envelope
   * and toasts on `!ok` so a too-large-vault / NO_ACTIVE_VAULT /
   * EACCES outcome doesn't silently mimic an empty vault.
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
        // Sprint B / B18 — separate "too many serialized bytes" from
        // "too many entries". The renderer surface the same vault:tree-too-large
        // toast for either signal so the user gets the right corrective
        // hint ("open a more specific folder") regardless of which cap
        // tripped first.
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
   * Phase 25 L6 — takes an explicit `vaultRoot` gated by `assertActiveVault`,
   * matching the contract every other write handler now uses. A buggy
   * renderer that passes a stale vault root (post-swap) is rejected before
   * the containment check, instead of silently mutating the open vault via
   * the module-level fallback.
   */
  ipcMain.handle('vault:create-folder', async (_event, vaultRoot: string, folderPath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertWithinVault(vaultRoot, folderPath);
      // Polish phase 1.3 + 6.3.P1/P2 — per-segment safety guard with
      // `forCreation: true`: rejects depth overrun, separators, `..`,
      // and Windows-illegal chars / reserved DOS names anywhere in the
      // new path. `forCreation` enforces the Win-only rules on every
      // platform so a Mac user can't seed a folder that breaks Windows.
      const relPath = relativePosix(vaultRoot, folderPath);
      assertSafeRelativePath(relPath, { forCreation: true });
      // Phase 1 / 1.2 — refuse mkdir inside `.filo/` via the generic
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
   *
   * Phase 27 / A6 — explicit `vaultRoot` arg gated by `assertActiveVault`.
   * Previously fell back to the module-level `currentVaultRoot` for the
   * containment check, so a buggy renderer that called this during a
   * post-swap window could probe a different vault than the one it
   * believed it was operating on. Mirrors `vault:rename` / `vault:delete`.
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
   *
   * Phase 25 L6 — explicit `vaultRoot` arg gated by `assertActiveVault`.
   * Mirrors `vault:write-file-text` and the rest of the post-Phase-21
   * write handlers; module-level `currentVaultRoot` is no longer the
   * containment reference.
   */
  ipcMain.handle('vault:rename', async (_event, vaultRoot: string, oldPath: string, newPath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertWithinVault(vaultRoot, oldPath);
      assertWithinVault(vaultRoot, newPath);
      // Phase 1 / 1.2 — refuse both src and dest if either lands inside
      // `.filo/`. A rename out of `.filo/` would let the renderer
      // exfiltrate config; a rename into `.filo/` would let it overwrite.
      assertNotInFiloDir(relativePosix(vaultRoot, oldPath));
      assertNotInFiloDir(relativePosix(vaultRoot, newPath));
      // Phase 31 A3.6 + 6.3.P1/P2 — defence-in-depth for the NEW
      // basename: rejects separators, `..`, Win-illegal chars, and
      // reserved DOS names. `forCreation: true` enforces the Win-only
      // rules on every platform so the rename target stays portable.
      // (The OLD basename intentionally isn't re-validated — a POSIX
      // file legitimately named `2025:01:15.md` must still rename.)
      assertSafeFilename(basename(newPath), { forCreation: true });
      // Sprint C / C-A5-1 — bracket renameItem with watcher suppression so
      // the in-app rename does NOT echo back as a `vault:file-renamed`
      // external event. Without this, every sidebar rename runs the full
      // `handleExternalRename` cascade a second time (renameBoardPath +
      // propagateRename + sentinel write + flushAllDirty + tag-store
      // rename helpers). The cascade is idempotent so no data corruption,
      // but it bills an extra recovery-sentinel write + dirty-flush per
      // rename — and on a folder rename touching every descendant, the
      // amplification scales linearly with the file count. Mirrors the
      // vault:delete suppression (Phase C / C.4) so the in-app delete
      // path doesn't surface "deleted externally" prompts either.
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
            activeWatcher!.suppress(rel, 2000);
          }
        };
        suppressFn(oldRel);
        suppressFn(newRel);
      }
      await renameItem(oldPath, newPath);
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
            activeWatcher!.suppress(rel, 2000);
          }
        };
        suppressFn(oldRel);
        suppressFn(newRel);
      }
      return { success: true };
    } catch (err) {
      // IMPL_PLAN_2026-05-26 / Item 2 — case-rename stranded: include the
      // temp path in the envelope so the renderer toast can name where
      // the file ended up. The user can recover it from File Explorer
      // rather than treating the rename failure as a data loss.
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
      // TARGET_EXISTS is a routine UX path (Phase 1 / 1.1) — the renderer
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
   * Phase 25 L6 — explicit `vaultRoot` arg gated by `assertActiveVault`.
   *
   * Phase C / C.4 — bracket the unlink with watcher suppression so the
   * cascade of OS-level delete events triggered by a user-initiated
   * folder delete doesn't flow into `handleExternalMarkdownChanges`.
   * Without this, a dirty editor on any file beneath the deleted folder
   * briefly sees the "deleted externally" prompt for a delete the user
   * just confirmed. The 5s window covers the unlink latency plus the
   * 300ms watcher debounce on slow disks.
   */
  ipcMain.handle('vault:delete', async (_event, vaultRoot: string, itemPath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertWithinVault(vaultRoot, itemPath);
      // Phase 1 / 1.2 — block generic deletes inside `.filo/` (except the
      // crash-recovery sentinel paths the helper allowlists). Recovery
      // sentinel cleanup in `dirtyFlagRecovery.markClean` /
      // `renameCascadeSentinel.clearSentinel` /
      // `tagRewriteSentinel.clearSentinel` flows through this channel
      // and stays whitelisted by the allowlist.
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
          activeWatcher.suppress(rel, 2000);
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
   * M3 (AUDIT_REMEDIATION_PLAN_2026-05-29) — `vault:watch` no longer
   * self-registers a vault. It now requires the open-vault handshake
   * (`vault:init-config`, which is the single registration authority) to
   * have already made `vaultPath` the active vault, and asserts the path
   * matches via `assertActiveVault`.
   *
   * Previously, calling this channel with NO vault registered self-registered
   * ANY stat-able directory — a buggy or compromised renderer could anchor
   * the active vault at an arbitrary host directory (`C:\Windows\System32`,
   * `~/.ssh`, …) and then read/write it through every
   * `assertActiveVault`-gated handler. The earlier Phase 21 / M1 guard only
   * stopped REDIRECTING an already-open watcher; the no-vault self-register
   * path stayed open. Requiring the handshake closes it: `vault:watch` can
   * only ever watch the vault the renderer legitimately opened.
   *
   * In every real flow `vault:init-config` runs before `vault:watch`
   * (`loadVaultCandidate` → commit → `runPostCommitTasks`), so this is a
   * tightening with no behaviour change for legitimate callers.
   *
   * The post-handshake `fs.stat` directory check is kept as defence: the
   * vault could have been deleted on disk between init-config and watch.
   */
  // Phase 3 / 3.5 — `lastReconcileAt` is declared up here (shared with the
  // `vault:reconcile` handler below) so `vault:watch` can reset it on a
  // vault swap. Without the reset, a focus-driven reconcile fired
  // immediately after the swap could be silently dropped by the 5 s
  // throttle if the OUTGOING vault's last reconcile fell inside the
  // window. Both handlers close over this single variable so the
  // throttle remains per-process while the swap-reset is well-defined.
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
      const stat = await fsPromises.stat(vaultPath);
      if (!stat.isDirectory()) {
        throw new Error('vaultPath is not a directory');
      }

      if (activeWatcher) {
        // Phase 3 / 3.1 — `stop()` is now async; it awaits any in-flight
        // reconcile walk so the OLD vault cannot emit late
        // `vault:files-changed` events under the NEW vault's listener.
        // Without the await, a slow walk in progress at swap time would
        // continue running, push synthesised events through the
        // 300ms debounce, and surface as "external edit" prompts naming
        // paths from the prior vault.
        await activeWatcher.stop();
      }
      // Sprint A / A3 — canonicalise via `realpathSync` once so the same
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
      // Mirror to the cross-window vault registry so the popout sidebar
      // window can synchronously read the active vault path on startup.
      vaultRegistry.setCurrentVault(canonical);
      activeWatcher = new FileWatcher(canonical);
      activeWatcher.start();
      // Phase 3 / 3.5 — reset the per-process reconcile throttle so the
      // very next `vault:reconcile` call (typically fired by the renderer
      // on window-focus immediately after the swap) is allowed through.
      // Without this, if the OLD vault's reconcile ran less than 5 s ago
      // the new vault's first focus-driven reconcile is silently dropped
      // and any drift on the NEW vault stays invisible until the periodic
      // 30s timer fires.
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
   * tabs back in. Phase 19 S2.
   *
   * D.5 — main-side throttle. The renderer already throttles its focus
   * handler to 5 s (`RECONCILE_FOCUS_THROTTLE_MS` in `vault.svelte.ts`),
   * but the IPC channel is reachable from anywhere in the renderer. A
   * regression or a buggy plugin that hammered this could pin the main
   * process on the full vault walk and starve every other IPC handler.
   * Refuse to run the walker more often than once every 5 s here too —
   * the bound matches the renderer-side cadence so legitimate users see
   * no behaviour change.
   *
   * Phase 3 / 3.5 — `RECONCILE_THROTTLE_MS` and `lastReconcileAt` are
   * declared with the `vault:watch` handler above so a vault swap can
   * reset the throttle. See the comment there for the rationale.
   */
  /**
   * Sprint B / B24 — closes the active vault: stops the watcher, drops the
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
   *
   * Phase 37 / 37.6 — the legacy single-arg absolute-path branch has
   * been removed. Every renderer caller now passes the tuple form.
   */
  ipcMain.handle('vault:read-file-text', async (_event, vaultRoot: string, relativePath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relativePath);
      const abs = join(vaultRoot, relativePath);
      assertWithinVault(vaultRoot, abs);
      // Sprint A / A9 — pre-flight stat caps the read at PAYLOAD_LIMITS.MARKDOWN
      // (25 MB). A multi-GB `.md` would otherwise OOM main on `readFile` /
      // OOM renderer on the toString shipped across IPC. Renderer surfaces the
      // dedicated FILE_TOO_LARGE code so the toast can say "file too large"
      // instead of "I/O error". ENOENT skips the cap check — `readFileContents`
      // surfaces the missing-file code through the normal catch path.
      //
      // F1 (2026-05-28) — the same pre-flight stat also yields the mtime
      // returned alongside the content so the renderer's hydrate path can
      // seed its drift baseline (fileBaselineRegistry) without issuing a
      // second `vault:stat`. A separate read-then-stat round-trip leaves a
      // TOCTOU gap in which an external write could skew the baseline against
      // the bytes we returned; capturing the mtime here keeps content + stamp
      // from one IPC call. stat-then-read ordering means a write landing in
      // the (tiny, same-process) gap skews the baseline OLDER than the bytes,
      // which surfaces a spurious Reload prompt rather than masking a real
      // external edit — the safe failure direction.
      let mtimeMs: number | undefined;
      let size: number | undefined;
      try {
        const stat = await fsPromises.stat(abs);
        if (stat.size > PAYLOAD_LIMITS.MARKDOWN) {
          return {
            success: false,
            code: 'FILE_TOO_LARGE' as const,
            error: `File is ${stat.size} bytes; vault:read-file-text cap is ${PAYLOAD_LIMITS.MARKDOWN} bytes`,
          };
        }
        mtimeMs = stat.mtimeMs;
        // Return size too for the hydrate path's (mtime, size) drift baseline.
        size = stat.size;
      } catch (statErr) {
        const sCode = (statErr as NodeJS.ErrnoException)?.code;
        if (sCode !== 'ENOENT') throw statErr;
        // ENOENT — `readFileContents` below throws the same code, so the
        // success branch (with mtimeMs / size) is unreachable for a missing file.
      }
      const content = await readFileContents(abs);
      return { success: true, content, mtimeMs, size };
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
   * Phase A.3 — returns the file's mtime + size so callers can detect
   * external edits between a read and a write. Used by
   * `syncTileMarkdown` to refuse silently clobbering an external edit
   * that landed in the read/write gap.
   *
   * On any failure (missing file, EACCES, NO_ACTIVE_VAULT) returns
   * `{ success: false }`; the renderer treats this as "no baseline" and
   * proceeds with the write (the legacy pre-Phase-A.3 behaviour).
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
        // 6.3.P1/P2 — `forCreation: true` because this channel mkdir-p's
        // + atomic-writes a NEW file; enforce Win-only rules on every
        // platform so cross-platform vaults stay portable.
        assertSafeRelativePath(relativePath, { forCreation: true });
        // Phase 1 / 1.2 — refuse generic writes into `.filo/` except for
        // the allowlisted crash-recovery sentinels. Dedicated channels
        // (config:save, tags:save, templates:write, theme:save) handle
        // legitimate `.filo/` writes.
        assertNotInFiloDir(relativePath);
        // Phase 21 / M5 — cap the Markdown text payload before we hit the
        // disk write. Computing byte length up front lets the renderer
        // surface "file too large" as a typed code instead of seeing a
        // generic write failure deep inside `atomicWriteFile`.
        assertPayloadByteSize(
          Buffer.byteLength(content, 'utf-8'),
          PAYLOAD_LIMITS.MARKDOWN,
          'vault:write-file-text',
        );
        const fullPath = join(vaultRoot, relativePath);
        assertWithinVault(vaultRoot, fullPath);
        await fsPromises.mkdir(dirname(fullPath), { recursive: true });
        activeWatcher?.suppress(relativePath, 2000);
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
        // Phase 1 / 1.2 — same `.filo/` guard as `vault:write-file-text`.
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
        activeWatcher?.suppress(relativePath, 2000);
        await atomicWriteFile(fullPath, content);
        activeWatcher?.suppress(relativePath, 1000);
        return { success: true, path: fullPath };
      } catch (err) {
        logMainError('vault:write-existing-file-text', err);
        return { success: false, code: ipcErrorCode(err), error: String(err) };
      }
    },
  );

  /**
   * Phase 2 / 2.5 — writes a binary file in the vault from a base64-encoded
   * payload. Used by `CascadeDeleteCommand.undo` to restore media files
   * (images, video, audio, pdf) that were captured before an external or
   * sidebar folder delete. Mirrors `vault:write-file-text`:
   *  - assertActiveVault / assertSafeRelativePath / assertNotInFiloDir
   *  - atomic write through `atomicWriteFile(Buffer)`
   *  - watcher suppression bracketing the rename
   *  - payload cap derived from PAYLOAD_LIMITS.MEDIA (post-decode bytes)
   *
   * The renderer captures media at most `TILE_DELETE_MEDIA_SNAPSHOT_MAX_BYTES`
   * (5 MB) per file, well under the MEDIA cap, so this handler primarily
   * serves the cascade-delete restore path. Other binary writers
   * (audio recordings) still go through `media:save-audio` which carries
   * a wider set of preconditions specific to that surface.
   */
  ipcMain.handle(
    'vault:write-file-binary',
    async (_event, vaultRoot: string, relativePath: string, base64: string) => {
      try {
        assertActiveVault(vaultRoot);
        // 6.3.P1/P2 — `forCreation: true`; binary writes create new files.
        assertSafeRelativePath(relativePath, { forCreation: true });
        assertNotInFiloDir(relativePath);
        const buffer = Buffer.from(base64, 'base64');
        assertPayloadByteSize(buffer.length, PAYLOAD_LIMITS.MEDIA, 'vault:write-file-binary');
        const fullPath = join(vaultRoot, relativePath);
        assertWithinVault(vaultRoot, fullPath);
        await fsPromises.mkdir(dirname(fullPath), { recursive: true });
        activeWatcher?.suppress(relativePath, 2000);
        await atomicWriteFile(fullPath, buffer);
        activeWatcher?.suppress(relativePath, 1000);
        return { success: true, path: fullPath };
      } catch (err) {
        logMainError('vault:write-file-binary', err);
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

  // Phase 8 / 8.5 — defensive caps on every renderer-supplied string that
  // lands in `recent-vaults.json`. A 4 KB path covers every legitimate OS
  // path (POSIX PATH_MAX is 4096; Windows extended paths cap at 32k but
  // 4k is comfortable for vault directories) and a null-byte check stops
  // a renderer-supplied embedded NUL from confusing downstream `path.*`
  // helpers (Node's path module truncates at the first NUL byte on
  // POSIX, which could let a smuggled path slip through later filters).
  const MAX_RECENT_PATH_LEN = 4096;
  const MAX_RECENT_NAME_LEN = 4096;
  const isSafeRecentString = (s: string, max: number): boolean =>
    s.length > 0 && s.length <= max && !s.includes('\0');

  ipcMain.handle('vault:add-recent', async (_event, path: unknown, name: unknown) => {
    if (typeof path !== 'string' || typeof name !== 'string') return [];
    if (!isSafeRecentString(path, MAX_RECENT_PATH_LEN)) return [];
    if (!isSafeRecentString(name, MAX_RECENT_NAME_LEN)) return [];
    // Sprint C / C21 — confirm the path actually points at an existing
    // directory before persisting it to `recent-vaults.json`. Without
    // this gate, any string the renderer passes (typo, deleted folder,
    // raw file path, network share that's gone offline) lands in the
    // recent list and the user gets a confusing "Vault not found" error
    // on next click. Surface the failure as an empty-array return so the
    // renderer's existing `loadRecentVaults` flow handles it.
    try {
      const stat = await fsPromises.stat(path);
      if (!stat.isDirectory()) return [];
    } catch {
      return [];
    }
    return addRecentVault(path, name);
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

  /**
   * Copies a file from an external source into the vault.
   *
   * `destFolder` is a vault-relative folder path. Pass an empty string (or
   * omit it) to drop the file at the vault root. Filename collisions are
   * resolved by suffixing `(1)`, `(2)`, … in `fileOps.copyFileToVault`.
   *
   * Returns both the absolute path and the relative path from the vault root.
   */
  ipcMain.handle(
    'vault:copy-file',
    async (
      _event,
      sourcePath: string,
      vaultPath: string,
      destFolder?: string,
    ) => {
      try {
        assertActiveVault(vaultPath);
        if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
          throw new Error('sourcePath must be a non-empty string');
        }
        // Stat the source before the copy so we can reject oversized imports
        // up front. Without this an accidental drop of a multi-GB file would
        // run a full copy, possibly fill the disk, before any caller learned
        // it failed. `fs.stat` also surfaces ENOENT cleanly via ipcErrorCode.
        //
        // Sprint A / A11 — `fs.lstat` (not `fs.stat`) so a symbolic link to
        // a character device like `/dev/zero` is rejected as "not a file"
        // up front. `stat` follows the symlink and reports `isFile()` on
        // the target; since `/dev/zero` has `size === 0`, the cap check
        // below would pass and `copyFile` would then read from /dev/zero
        // until disk is full (no EOF). `lstat` reports the SYMLINK's type,
        // which is `isSymbolicLink()` not `isFile()`, so we refuse.
        // Regular files lstat as `isFile()` so the legitimate path is
        // unchanged.
        const sourceStat = await fsPromises.lstat(sourcePath);
        if (!sourceStat.isFile()) {
          return { success: false, code: 'IO_ERROR', error: 'Source is not a regular file' };
        }
        if (sourceStat.size > VAULT_COPY_MAX_SIZE_BYTES) {
          return {
            success: false,
            code: 'FILE_TOO_LARGE',
            error: `Source file is ${sourceStat.size} bytes; vault:copy-file cap is ${VAULT_COPY_MAX_SIZE_BYTES} bytes`,
          };
        }
        const subfolder =
          typeof destFolder === 'string' && destFolder.trim().length > 0
            ? toPosix(destFolder).replace(/^\/+/, '').replace(/\/+$/, '')
            : undefined;
        // Phase 37 / 37.5 + 6.3.P1/P2 — segment-level validation on the
        // subfolder (a per-segment reserved name would pass `assertWithinVault`
        // but still open a device handle on Windows). `forCreation: true`
        // because this channel creates new subfolders + file paths.
        if (subfolder) assertSafeRelativePath(subfolder, { forCreation: true });

        // Phase 1 / 1.2 — refuse `.filo/` on both ends:
        //  - dest: the subfolder + basename pair must not land inside `.filo/`
        //  - src: if the source happens to live INSIDE the vault under
        //    `.filo/`, refuse — generic copy must not exfiltrate config.
        if (subfolder) {
          const destRel = `${subfolder}/${basename(sourcePath)}`;
          assertNotInFiloDir(destRel);
        } else {
          assertNotInFiloDir(basename(sourcePath));
        }
        const sourceRel = relativePosix(vaultPath, sourcePath);
        if (sourceRel && !sourceRel.startsWith('..') && !sourceRel.startsWith('/')) {
          assertNotInFiloDir(sourceRel);
        }

        const destPath = await copyFileToVault(sourcePath, vaultPath, subfolder);
        assertWithinVault(vaultPath, destPath);
        const relativePath = relativePosix(vaultPath, destPath);
        return { success: true, path: destPath, relativePath };
      } catch (err) {
        logMainError('vault:copy-file', err);
        return { success: false, code: ipcErrorCode(err), error: String(err) };
      }
    },
  );
}
