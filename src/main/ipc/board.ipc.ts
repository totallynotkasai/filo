import { ipcMain } from 'electron';
import { LOCK_AWARE_SUPPRESS_MS, retryOnWindowsLock, lockRetryBudgetMs } from '../vault/filenameUtils';
import { BoardTooLargeError, classifyBoardLoadError } from '../vault/boardLoadErrors';

import {
  loadBoardFile,
  saveBoardFile,
  createBoardFile,
  deleteBoardFile,
  scanBoardFiles,
  resolveBoardPath,
  scanBoardConflicts,
} from '../vault/boardFileOps';
import { loadKnownHosts } from '../services/syncConflictNotifier';
import { registerMachineInVault } from '../services/machineIdentity';
import {
  initVaultConfig,
  loadConfig,
  saveConfig,
  isConfigFile,
  loadAppConfig,
  loadAppearanceConfig,
  loadDefaultsConfig,
  loadHotkeysConfig,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  loadViewportsConfig,
  loadSidebarOrderConfig,
  listThemes,
  loadTheme,
  saveTheme,
  deleteTheme,
  ThemeParseError,
} from '../vault/configOps';
import {
  assertWithinVault,
  assertSafeFilename,
  assertSafeRelativePath,
  assertNotInFiloDir,
} from '../utils/pathSecurity';
import { assertActiveVault, isActiveVault, NoActiveVaultError } from '../utils/activeVaultCheck';
import { logMainError } from '../utils/mainLogger';
import { vaultRegistry } from '../services/vaultRegistry';
import { getActiveWatcher } from './vault.ipc';
import { snapshotForRecovery, listRecoverySnapshots } from '../services/recoverySnapshot';
import { sweepOrphanTmpFiles } from '../services/orphanTmpSweep';
import { toPosix } from '../utils/pathHelpers';
import {
  assertPayloadByteSize,
  jsonPayloadByteSize,
  PAYLOAD_LIMITS,
  PayloadTooLargeError,
} from '../utils/payloadLimits';

/** Lock-retry budget for ONE board read at vault open. */
const BOARD_LOAD_LOCK_BUDGET_MS = 1500;

/**
 * Returns a `code` field for an IPC error response. `NO_ACTIVE_VAULT` /
 * `FILE_TOO_LARGE` are surfaced explicitly so the renderer can distinguish
 * "you tried to operate on a vault that isn't open" / "payload exceeded
 * the cap" from a generic disk / parse failure.
 */
function classifyError(err: unknown): 'NO_ACTIVE_VAULT' | 'FILE_TOO_LARGE' | undefined {
  if (err instanceof NoActiveVaultError) return 'NO_ACTIVE_VAULT';
  if (err instanceof PayloadTooLargeError) return 'FILE_TOO_LARGE';
  return undefined;
}

/**
 * Registers IPC handlers for the vault-centric (V7) architecture.
 *
 * These handlers support the design doc's .board.json file model
 * and .filo/ config directory structure.
 */
export function registerBoardHandlers(): void {

  // ── Vault Initialization ──

  /**
   * Initializes a vault's .filo/ config directory with default files.
   * Safe to call on an already-initialized vault (existing files not overwritten).
   *
   * Three layered guards before the registry mutation:
   *
   *   1. Non-empty string — already enforced upstream by the preload
   *      `validateIpcPayload` against `IPC_PAYLOAD_SCHEMAS['vault:init-config']`
   *      (`z.tuple([nonEmptyString])`). The explicit type/length check
   *      below is defence-in-depth for callers that bypass the preload
   *      wrapper (e.g. main-process unit tests).
   *   2. The path must resolve to an existing directory. Without this a
   *      buggy renderer could "open" `C:\\Users\\Public\\not-a-dir` and
   *      anchor the registry there — every subsequent `assertActiveVault`
   *      check would then accept writes against a non-existent vault.
   *   3. Refuse re-registration: if a vault is already active, the caller
   *      must explicitly close it first (`vaultRegistry.setCurrentVault(null)`
   *      via the close-vault flow). Silently swapping the registry under
   *      live IPC handlers is a known footgun — board:save / config:save
   *      mid-debounce would then write into the new vault's root.
   */
  ipcMain.handle('vault:init-config', async (_event, vaultRoot: string) => {
    try {
      if (typeof vaultRoot !== 'string' || vaultRoot.length === 0) {
        throw new Error('vaultRoot must be a non-empty string');
      }
      // Pre-stat as a directory before we touch the registry. `fs.stat`
      // throws ENOENT on a missing path and ENOTDIR on a file — both land
      // in the catch below as a clean error toast.
      const { promises: fs } = await import('fs');
      const stat = await fs.stat(vaultRoot);
      if (!stat.isDirectory()) {
        throw new Error('vaultRoot is not a directory');
      }
      // Refuse to re-anchor if a different vault is already open. Matching
      // path → idempotent success (re-init of the same vault after a
      // restart-without-close is fine). Different path → require the
      // close flow to clear the registry first.
      const current = vaultRegistry.currentVaultPath;
      if (current && !isActiveVault(vaultRoot)) {
        throw new Error(
          'A different vault is already active — close it before initialising a new one',
        );
      }
      // `vault:init-config` is the bootstrap call that marks the renderer's
      // intent to open `vaultRoot`. It runs BEFORE `vault:watch`, so the
      // registry doesn't reflect the new vault yet — register it now so
      // every subsequent IPC handler can safely `assertActiveVault`. The
      // watcher is started later (vault:watch); registering here is purely
      // about gating the IPC surface.
      vaultRegistry.setCurrentVault(vaultRoot);
      try {
        await initVaultConfig(vaultRoot);
        // Record this machine in `.filo/machines/` (labels foreign sentinels
        // + feeds the conflict-copy host list). Best-effort.
        await registerMachineInVault(vaultRoot);
      } catch (initErr) {
        // Roll the registry back so a failed `.filo/` init (EACCES, ENOSPC, a
        // flaky share) doesn't leave a half-initialised vault armed, which
        // would block re-opening a DIFFERENT vault via the guard above.
        // Restore the PRIOR value (not null) so a same-vault re-init failure
        // leaves the active vault armed.
        vaultRegistry.setCurrentVault(current);
        throw initErr;
      }
      return { ok: true };
    } catch (err) {
      logMainError('vault:init-config', err);
      return { ok: false, error: String(err) };
    }
  });

  // ── Board Operations ──

  /**
   * Lists all .board.json files in the vault.
   * Returns vault-relative paths.
   */
  ipcMain.handle('board:list', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
      return await scanBoardFiles(vaultRoot);
    } catch (err) {
      logMainError('board:list', err);
      return [];
    }
  });

  /**
   * Lists sync-client conflict forks of boards
   * (`Plan.board-HOST.json` …) whose canonical `*.board.json` exists. Kept
   * separate from `board:list` so its bare `string[]` contract is unchanged.
   */
  ipcMain.handle('board:list-conflicts', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
      const hosts = await loadKnownHosts(vaultRoot);
      return { success: true, copies: await scanBoardConflicts(vaultRoot, hosts) };
    } catch (err) {
      logMainError('board:list-conflicts', err);
      const code = classifyError(err);
      return { success: false, ...(code ? { code } : {}), error: String(err) };
    }
  });

  /**
   * Loads a .board.json file. Returns `{ success: true, data }` (the parsed
   * board; the caller validates with Zod) or a typed failure code (ENOENT /
   * LOCKED / OFFLINE / TOO_LARGE / PARSE / IO).
   *
   * A pre-flight stat caps the file at the same size limit
   * the writer uses (PAYLOAD_LIMITS.BOARD = 50 MB). A larger `.board.json`
   * either indicates corruption or a runaway tile-spam loop; in either
   * case we refuse to load it rather than OOM the renderer on a multi-GB
   * read. The caller surfaces a toast via the failedBoards path.
   */
  ipcMain.handle('board:load', async (_event, vaultRoot: string, relativePath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relativePath);
      const fullPath = resolveBoardPath(vaultRoot, relativePath);
      assertWithinVault(vaultRoot, fullPath);
      // Retry a transient Windows lock (OneDrive / antivirus) with a SHORT
      // budget: one board mustn't stall the vault open for 5 s.
      const budgetMs = Math.min(BOARD_LOAD_LOCK_BUDGET_MS, lockRetryBudgetMs());
      const { promises: fs } = await import('fs');
      // Refuse to load `.board.json` files larger than PAYLOAD_LIMITS.BOARD.
      const stat = await retryOnWindowsLock(() => fs.stat(fullPath), { budgetMs });
      if (stat.size > PAYLOAD_LIMITS.BOARD) throw new BoardTooLargeError(stat.size, PAYLOAD_LIMITS.BOARD);
      const data = await retryOnWindowsLock(() => loadBoardFile(fullPath), { budgetMs });
      return { success: true, data };
    } catch (err) {
      // A typed code instead of a bare `null`: a lock or an
      // offline cloud placeholder must not read as "not-found" (the board would
      // be gone for the whole session with no way back but reopening the vault).
      if (err instanceof NoActiveVaultError) {
        return { success: false, code: 'NO_ACTIVE_VAULT', error: String(err) };
      }
      const code = classifyBoardLoadError(err);
      if (code !== 'ENOENT') logMainError(`board:load ${relativePath}`, err);
      return { success: false, code, error: String(err) };
    }
  });

  /**
   * Saves data to a .board.json file.
   */
  ipcMain.handle('board:save', async (_event, vaultRoot: string, relativePath: string, data: unknown) => {
    try {
      assertActiveVault(vaultRoot);
      // `board:save` is a CREATING channel (the first save writes a brand-new
      // `.board.json`), so validate with `forCreation: true`: a POSIX user
      // must not author a board path that breaks the vault on Windows.
      // (`board:load`/`board:delete` stay creation-free — they operate on
      // paths that already exist; see gates:no-forcreation-on-read-delete.)
      assertSafeRelativePath(relativePath, { forCreation: true });
      assertPayloadByteSize(jsonPayloadByteSize(data), PAYLOAD_LIMITS.BOARD, 'board:save');
      const fullPath = resolveBoardPath(vaultRoot, relativePath);
      assertWithinVault(vaultRoot, fullPath);
      // Suppress watcher events for the self-write. board files use
      // atomicWriteFile (write `.tmp` → rename to final), which on Windows
      // can retry up to ~310ms on EPERM/EBUSY. The watcher then debounces
      // 300ms after the final event, so the rename event can land 600ms+
      // after suppress() was called — past the 500ms default. Use 2000ms
      // for comfortable safety, and re-suppress AFTER the write completes
      // so events generated by the rename itself are caught even if they
      // arrive on a delayed flush.
      const watcher = getActiveWatcher();
      watcher?.suppress(relativePath, LOCK_AWARE_SUPPRESS_MS);
      await saveBoardFile(fullPath, data);
      watcher?.suppress(relativePath, 1000);
      return { ok: true };
    } catch (err) {
      logMainError(`board:save ${relativePath}`, err);
      return { ok: false, error: String(err) };
    }
  });

  /**
   * Creates a new .board.json file. Returns the vault-relative path.
   */
  ipcMain.handle('board:create', async (_event, vaultRoot: string, name: string, data: unknown, subfolder?: string) => {
    try {
      assertActiveVault(vaultRoot);
      // Defence-in-depth — reject `..`, absolute paths, NUL bytes, Windows
      // reserved names, and excessive depth on the subfolder before
      // `createBoardFile` joins it onto vaultRoot and writes the JSON.
      // `assertWithinVault` below would also catch a traversal, but only
      // after the file has been written outside the vault. `forCreation`
      // applies the Windows-only rules on every platform.
      if (subfolder) assertSafeRelativePath(subfolder, { forCreation: true });
      // Reject DOS device names (CON, NUL, LPT1, ...) on the board name:
      // `CON.board.json` would open a console device handle on Windows and
      // the write would no-op or hang the IPC.
      assertSafeFilename(`${name}.board.json`, { forCreation: true });
      assertPayloadByteSize(jsonPayloadByteSize(data), PAYLOAD_LIMITS.BOARD, 'board:create');
      const fullPath = await createBoardFile(vaultRoot, name, data, subfolder);
      assertWithinVault(vaultRoot, fullPath);
      const relativePath = toPosix(fullPath.replace(vaultRoot, '')).replace(/^\/+/, '');
      return { ok: true, path: relativePath };
    } catch (err) {
      logMainError(`board:create ${name}`, err);
      return { ok: false, error: String(err) };
    }
  });

  /**
   * Deletes a .board.json file.
   */
  ipcMain.handle('board:delete', async (_event, vaultRoot: string, relativePath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relativePath);
      const fullPath = resolveBoardPath(vaultRoot, relativePath);
      assertWithinVault(vaultRoot, fullPath);
      await deleteBoardFile(fullPath);
      return { ok: true };
    } catch (err) {
      logMainError(`board:delete ${relativePath}`, err);
      return { ok: false, error: String(err) };
    }
  });

  // ── Config Operations ──

  /**
   * Loads a config file from .filo/.
   * Returns parsed JSON, `{}` only if the file doesn't exist, the
   * `{ __corrupt }` marker for an unparseable / oversized file, or
   * `{ __loadFailed }` when it couldn't be read at all.
   */
  ipcMain.handle('config:load', async (_event, vaultRoot: string, file: string) => {
    try {
      assertActiveVault(vaultRoot);
      if (!isConfigFile(file)) {
        throw new Error(`Unknown config file: ${file}`);
      }
      return await loadConfig(vaultRoot, file, {});
    } catch (err) {
      logMainError(`config:load ${file}`, err);
      // Never `{}`: that reads as "file absent", so a transient EBUSY/EPERM
      // would install empty settings and the next save would wipe the file.
      return { __loadFailed: true, error: String(err) };
    }
  });

  /**
   * Saves a config file to .filo/.
   */
  ipcMain.handle('config:save', async (_event, vaultRoot: string, file: string, data: unknown) => {
    try {
      assertActiveVault(vaultRoot);
      if (!isConfigFile(file)) {
        throw new Error(`Unknown config file: ${file}`);
      }
      assertPayloadByteSize(jsonPayloadByteSize(data), PAYLOAD_LIMITS.CONFIG, `config:save ${file}`);
      await saveConfig(vaultRoot, file, data);
      return { ok: true };
    } catch (err) {
      logMainError(`config:save ${file}`, err);
      const code = classifyError(err);
      return { ok: false, ...(code ? { code } : {}), error: String(err) };
    }
  });

  /**
   * Loads all config files at once (for vault open).
   * Returns an object with all config data.
   */
  ipcMain.handle('config:load-all', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
      const [app, appearance, defaults, hotkeys, workspace, viewports, sidebarOrder] = await Promise.all([
        loadAppConfig(vaultRoot),
        loadAppearanceConfig(vaultRoot),
        loadDefaultsConfig(vaultRoot),
        loadHotkeysConfig(vaultRoot),
        loadWorkspaceConfig(vaultRoot),
        loadViewportsConfig(vaultRoot),
        loadSidebarOrderConfig(vaultRoot),
      ]);
      return { app, appearance, defaults, hotkeys, workspace, viewports, sidebarOrder };
    } catch (err) {
      logMainError('config:load-all', err);
      // Only a hard error the per-file loaders re-throw lands here (e.g. a
      // transient EACCES/EPERM under a OneDrive/AV lock; ENOENT and parse
      // failures are handled inside `loadConfig`). An all-empty return would
      // seed BOOTSTRAP DEFAULTS in memory, and a later save could overwrite
      // the intact-but-locked files on disk. Tag the (still bare) bag with a
      // failure marker so `loadVaultCandidate` pauses every config write and
      // toasts instead. Reopening the vault retries the read.
      return {
        app: {}, appearance: {}, defaults: {}, hotkeys: {}, workspace: {}, viewports: {}, sidebarOrder: {},
        __loadAllFailed: String(err),
      };
    }
  });

  /**
   * Saves workspace state (called on tab/pane changes and before quit).
   */
  ipcMain.handle('config:save-workspace', async (_event, vaultRoot: string, data: unknown) => {
    try {
      assertActiveVault(vaultRoot);
      assertPayloadByteSize(jsonPayloadByteSize(data), PAYLOAD_LIMITS.CONFIG, 'config:save-workspace');
      await saveWorkspaceConfig(vaultRoot, data);
      return { ok: true };
    } catch (err) {
      logMainError('config:save-workspace', err);
      const code = classifyError(err);
      return { ok: false, ...(code ? { code } : {}), error: String(err) };
    }
  });

  // ── Theme Operations ──

  ipcMain.handle('theme:list', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
      return await listThemes(vaultRoot);
    } catch (err) {
      logMainError('theme:list', err);
      return [];
    }
  });

  ipcMain.handle('theme:load', async (_event, vaultRoot: string, name: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeFilename(name);
      return await loadTheme(vaultRoot, name);
    } catch (err) {
      // Distinguish parse failure from missing-file. A hand-edited theme
      // that's no longer valid JSON returns an envelope so
      // `refreshAvailable` can aggregate every failing theme into one toast.
      // ENOENT keeps the bare-null shape ("theme not found").
      if (err instanceof ThemeParseError) {
        logMainError(`theme:load ${name}`, err);
        return { ok: false, code: 'invalid-json', name, error: err.message };
      }
      // ENOENT just means the user named a built-in theme rather than a
      // theme file (e.g. `dark` rather than `dark-mode`). The renderer
      // short-circuits built-ins so this should rarely fire, but other
      // code paths (theme:list iteration with a stale id) might trigger
      // it. Skip the stack trace; return null as the caller expects.
      if ((err as { code?: string } | null)?.code !== 'ENOENT') {
        logMainError(`theme:load ${name}`, err);
      }
      return null;
    }
  });

  ipcMain.handle('theme:save', async (_event, vaultRoot: string, name: string, data: unknown) => {
    try {
      assertActiveVault(vaultRoot);
      // `theme:save` creates `<vault>/.filo/themes/<name>.json`;
      // creation rules apply on every platform so a saved theme stays
      // portable.
      assertSafeFilename(name, { forCreation: true });
      assertPayloadByteSize(jsonPayloadByteSize(data), PAYLOAD_LIMITS.THEME, `theme:save ${name}`);
      await saveTheme(vaultRoot, name, data);
      return { ok: true };
    } catch (err) {
      logMainError(`theme:save ${name}`, err);
      const code = classifyError(err);
      return { ok: false, ...(code ? { code } : {}), error: String(err) };
    }
  });

  ipcMain.handle('theme:delete', async (_event, vaultRoot: string, name: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeFilename(name);
      await deleteTheme(vaultRoot, name);
      return { ok: true };
    } catch (err) {
      logMainError(`theme:delete ${name}`, err);
      const code = classifyError(err);
      return { ok: false, ...(code ? { code } : {}), error: String(err) };
    }
  });

  // ── Recovery Snapshot ──

  /**
   * Copies a vault file's bytes into `.filo/recovery/<timestamp>/<basename>`
   * so the originals are preserved before Filo's write pipeline gets a
   * chance to overwrite them. Triggered by the renderer when a `.board.json`
   * (or other vault file) fails to load — see `loadAllBoards`.
   *
   * Returns `{ ok: true, path }` on success where `path` is the absolute
   * destination. Failure mode is non-fatal — the caller's primary recovery
   * path is the toast surfaced via `errorBus`; the snapshot is a defensive
   * backup, not a precondition.
   */
  ipcMain.handle('recovery:snapshot', async (_event, vaultRoot: string, relativePath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relativePath);
      // Refuse snapshots of `.filo/` contents: copying config files into the
      // recovery directory would be an exfiltration vector for vault-internal
      // state. The dedicated tags/templates/theme channels own those files.
      assertNotInFiloDir(relativePath);
      const destAbs = await snapshotForRecovery(vaultRoot, relativePath);
      return { ok: true, path: destAbs };
    } catch (err) {
      logMainError(`recovery:snapshot ${relativePath}`, err);
      // Pass the errno through (ENOENT = nothing to back up;
      // EBUSY / RECOVERY_SNAPSHOT_TOO_LARGE = the keep-local backup failed).
      const errno = (err as NodeJS.ErrnoException | null)?.code;
      const code = classifyError(err) ?? (typeof errno === 'string' ? errno : undefined);
      return { ok: false, ...(code ? { code } : {}), error: String(err) };
    }
  });

  /**
   * Lists preserved snapshots under `.filo/recovery/` so the renderer can
   * surface them on vault open (basename + timestamp + reveal). Read-only: it
   * never prunes. BARE channel (returns the array directly, like
   * `theme:load`); a scan failure is logged and re-thrown (see below).
   */
  ipcMain.handle('recovery:list', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
      return await listRecoverySnapshots(vaultRoot);
    } catch (err) {
      logMainError('recovery:list', err);
      // ENOENT is already mapped to `[]`, so anything here is a REAL scan
      // failure (a locked share, ENOTDIR, NO_ACTIVE_VAULT after a swap).
      // Returning `[]` would hide the user's backup exactly when the disk is
      // locked; re-throw so the renderer toasts "couldn't scan recovery".
      throw err;
    }
  });

  /**
   * Sweeps orphaned atomic-write temps (older than 10 min,
   * not listed by any quit-failure breadcrumb, not tracked by this process)
   * into `.filo/recovery/orphan-tmp/`. The renderer calls it on vault open
   * AFTER surfacing the quit-failure breadcrumb. Moves, never deletes.
   */
  ipcMain.handle('vault:sweep-orphan-tmp', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
      return { success: true, ...(await sweepOrphanTmpFiles(vaultRoot)) };
    } catch (err) {
      logMainError('vault:sweep-orphan-tmp', err);
      const code = classifyError(err);
      return { success: false, ...(code ? { code } : {}), error: String(err) };
    }
  });
}
