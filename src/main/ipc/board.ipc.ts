import { ipcMain } from 'electron';
import { LOCK_AWARE_SUPPRESS_MS, retryOnWindowsLock, lockRetryBudgetMs } from '../vault/filenameUtils';
import { BoardTooLargeError, classifyBoardLoadError } from '../vault/boardLoadErrors';

import {
  loadBoardFile,
  saveBoardFile,
  createBoardFile,
  boardFilePath,
  scanBoardFiles,
  resolveBoardPath,
  scanBoardConflicts,
  serializeBoardPayload,
} from '../vault/boardFileOps';
import { loadKnownHosts } from '../services/syncConflictNotifier';
import { getMachineIdentity, registerMachineInVault } from '../services/machineIdentity';
import {
  initVaultConfig,
  loadConfig,
  saveConfig,
  isConfigFile,
  isBackupableConfigPath,
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
  trashTheme,
  ThemeParseError,
} from '../vault/configOps';
import {
  assertWithinVault,
  vaultRelativeWithin,
  assertSafeFilename,
  assertSafeRelativePath,
  assertNotInFiloDir,
} from '../utils/pathSecurity';
import { assertActiveVault, isActiveVault, NoActiveVaultError } from '../utils/activeVaultCheck';
import { logMainError } from '../utils/mainLogger';
import { errorEnvelope } from './ipcErrorCode';
import { vaultRegistry } from '../services/vaultRegistry';
import { getActiveWatcher } from './vault.ipc';
import { snapshotForRecovery, listRecoverySnapshots, type SnapshotPurpose } from '../services/recoverySnapshot';
import { sweepOrphanTmpFiles } from '../services/orphanTmpSweep';
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
 * Registers IPC handlers for the vault-centric architecture.
 *
 * These handlers support the design doc's .board.json file model
 * and .filo/ config directory structure.
 */
/**
 * Tells the watcher the bytes a board write left on disk. Its cached size and
 * hash otherwise describe the file before the write until the next reconcile,
 * so another program renaming the board (or its folder) straight after a save
 * isn't paired as a rename: the board looks deleted and its new file like a
 * copy with the same id.
 */
function recordBoardWrite(relativePath: string, json: string): void {
  getActiveWatcher()?.recordOwnWrite(relativePath, Buffer.from(json, 'utf-8'));
}

/**
 * `stat` of a folder about to be opened as a vault. A missing folder on a
 * drive or share that can't be reached (a USB drive unplugged, a share
 * offline) fails with `ENODEV` instead of `ENOENT`, so the renderer can tell
 * "moved or deleted" from "not available right now" and keep the recent entry.
 */
async function statVaultFolder(vaultRoot: string): Promise<import('fs').Stats> {
  const { promises: fs } = await import('fs');
  const { parse } = await import('path');
  try {
    return await fs.stat(vaultRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw err;
    const root = parse(vaultRoot).root;
    const rootReachable = root ? await fs.stat(root).then(() => true, () => false) : true;
    if (rootReachable) throw err;
    throw Object.assign(new Error(`The drive or share holding "${vaultRoot}" isn't available`), { code: 'ENODEV' });
  }
}

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
      // Pre-stat as a directory before we touch the registry. A missing path
      // (ENOENT, or ENODEV when its drive is gone) and a file (ENOTDIR) land
      // in the catch below as a clean error toast.
      const stat = await statVaultFolder(vaultRoot);
      if (!stat.isDirectory()) {
        throw Object.assign(new Error('vaultRoot is not a directory'), { code: 'ENOTDIR' });
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
      return errorEnvelope(err);
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
   * Saves data to an existing board's .board.json file. A missing folder fails
   * with `BOARD_FOLDER_MISSING` unless `opts.recreate` (the user's "Save at
   * original location") asks for it back.
   */
  ipcMain.handle('board:save', async (_event, vaultRoot: string, relativePath: string, data: unknown, opts?: { recreate?: boolean }) => {
    try {
      assertActiveVault(vaultRoot);
      // `board:save` is a CREATING channel (the first save writes a brand-new
      // `.board.json`), so validate with `forCreation: true`: a POSIX user
      // must not author a board path that breaks the vault on Windows.
      // (`board:load` stays creation-free — it operates on a path that
      // already exists; see gates:no-forcreation-on-read-delete.)
      assertSafeRelativePath(relativePath, { forCreation: true });
      assertPayloadByteSize(jsonPayloadByteSize(data), PAYLOAD_LIMITS.BOARD, 'board:save');
      const fullPath = resolveBoardPath(vaultRoot, relativePath);
      assertWithinVault(vaultRoot, fullPath);
      // Hide the self-write's echo, and only that: the window drops an event
      // only while the file holds the bytes written here, so another program
      // saving the board inside it (a sync landing just after a Filo save) is
      // still reported. The window is lock-aware because atomicWriteFile can
      // retry for seconds on a Windows lock before its rename lands, and it is
      // extended after the write so a delayed rename event is still caught.
      const watcher = getActiveWatcher();
      watcher?.suppressWrite(relativePath, LOCK_AWARE_SUPPRESS_MS, serializeBoardPayload(data));
      const json = await saveBoardFile(fullPath, data, { recreate: opts?.recreate === true });
      watcher?.suppressWrite(relativePath, 1000, json);
      recordBoardWrite(relativePath, json);
      return { ok: true };
    } catch (err) {
      logMainError(`board:save ${relativePath}`, err);
      return errorEnvelope(err);
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
      // The name is also the file stem, used verbatim (never sanitised), so a
      // trailing dot or space in the name itself is refused too.
      assertSafeFilename(name, { forCreation: true });
      assertSafeFilename(`${name}.board.json`, { forCreation: true });
      assertPayloadByteSize(jsonPayloadByteSize(data), PAYLOAD_LIMITS.BOARD, 'board:create');
      // The create reserves a 0-byte placeholder, then writes the JSON over it.
      // On a slow disk the watcher's debounce can fire in between, and the
      // renderer would read the empty file as a broken board from another
      // program. Hide the path up front, but only while it holds one of those
      // two contents: another program's file at the name still gets through.
      const plannedRel = vaultRelativeWithin(vaultRoot, boardFilePath(vaultRoot, name, subfolder));
      getActiveWatcher()?.suppressWrite(plannedRel, LOCK_AWARE_SUPPRESS_MS, '');
      getActiveWatcher()?.suppressWrite(plannedRel, LOCK_AWARE_SUPPRESS_MS, serializeBoardPayload(data));
      // A taken name fails here with EEXIST (`TARGET_EXISTS` to the renderer),
      // before anything is written.
      const fullPath = await createBoardFile(vaultRoot, name, data, subfolder);
      // `path.relative`, not a string strip: the root the renderer sends can be
      // spelled differently from the path `createBoardFile` joined (forward
      // slashes, a trailing separator), and a strip that misses returns an
      // absolute path every later `board:save` of the board refuses.
      const relativePath = vaultRelativeWithin(vaultRoot, fullPath);
      // Hidden after the write (a refused create changes nothing); the
      // watcher's debounce still holds the event then. Unhidden, the create
      // reaches the renderer as an external change to a board the user may
      // already be editing, and asks "modified externally". Only while it
      // holds the bytes written: another program's save right after is news.
      getActiveWatcher()?.suppressWrite(relativePath, LOCK_AWARE_SUPPRESS_MS, serializeBoardPayload(data));
      recordBoardWrite(relativePath, serializeBoardPayload(data));
      // The new file's stat seeds the renderer's drift baseline, so the first
      // save has an anchor without waiting for a load. Best-effort: without
      // it the first save simply runs unchecked, as before.
      let stat: { mtimeMs: number; size: number } | undefined;
      try {
        const { promises: fs } = await import('fs');
        const s = await fs.stat(fullPath);
        stat = { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        stat = undefined;
      }
      return { ok: true, path: relativePath, ...stat };
    } catch (err) {
      logMainError(`board:create ${name}`, err);
      return errorEnvelope(err);
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
  ipcMain.handle('config:save', async (_event, vaultRoot: string, file: string, data: unknown, opts?: { createOnly?: boolean }) => {
    try {
      assertActiveVault(vaultRoot);
      if (!isConfigFile(file)) {
        throw new Error(`Unknown config file: ${file}`);
      }
      assertPayloadByteSize(jsonPayloadByteSize(data), PAYLOAD_LIMITS.CONFIG, `config:save ${file}`);
      await saveConfig(vaultRoot, file, data, { createOnly: opts?.createOnly === true });
      return { ok: true };
    } catch (err) {
      logMainError(`config:save ${file}`, err);
      return errorEnvelope(err);
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
      return errorEnvelope(err);
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
      return errorEnvelope(err);
    }
  });

  ipcMain.handle('theme:delete', async (_event, vaultRoot: string, name: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeFilename(name);
      await trashTheme(vaultRoot, name, getMachineIdentity().machineId);
      return { ok: true };
    } catch (err) {
      logMainError(`theme:delete ${name}`, err);
      return errorEnvelope(err);
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
  ipcMain.handle('recovery:snapshot', async (_event, vaultRoot: string, relativePath: string, purpose?: SnapshotPurpose) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relativePath);
      // Refuse snapshots of `.filo/` contents: copying config files into the
      // recovery directory would be an exfiltration vector for vault-internal
      // state. The dedicated tags/templates/theme channels own those files.
      // The one exception: the other version of a Filo config file that Keep
      // local is about to overwrite, copied within `.filo/`.
      if (!(purpose === 'keep' && isBackupableConfigPath(relativePath))) assertNotInFiloDir(relativePath);
      const destAbs = await snapshotForRecovery(vaultRoot, relativePath, purpose);
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
