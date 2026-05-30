import { ipcMain } from 'electron';
import {
  loadBoardFile,
  saveBoardFile,
  createBoardFile,
  deleteBoardFile,
  scanBoardFiles,
  resolveBoardPath,
} from '../vault/boardFileOps';
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
import { snapshotForRecovery } from '../services/recoverySnapshot';
import { toPosix } from '../utils/pathHelpers';
import {
  assertPayloadByteSize,
  jsonPayloadByteSize,
  PAYLOAD_LIMITS,
  PayloadTooLargeError,
} from '../utils/payloadLimits';

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
   * Phase 1 / 1.2 — three layered guards before the registry mutation:
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
      await initVaultConfig(vaultRoot);
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
   * Loads a .board.json file. Returns raw parsed JSON.
   * Caller validates with Zod in the renderer.
   *
   * Phase 31 A5.4 — pre-flight stat caps the file at the same size limit
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
      // A5.4 — refuse to load `.board.json` files larger than PAYLOAD_LIMITS.BOARD.
      try {
        const { promises: fs } = await import('fs');
        const stat = await fs.stat(fullPath);
        if (stat.size > PAYLOAD_LIMITS.BOARD) {
          logMainError(`board:load ${relativePath}`, new Error(`File too large: ${stat.size} > ${PAYLOAD_LIMITS.BOARD}`));
          return null;
        }
      } catch (statErr) {
        const sCode = (statErr as NodeJS.ErrnoException)?.code;
        if (sCode !== 'ENOENT') {
          logMainError(`board:load:stat ${relativePath}`, statErr);
        }
      }
      return await loadBoardFile(fullPath);
    } catch (err) {
      logMainError(`board:load ${relativePath}`, err);
      return null;
    }
  });

  /**
   * Saves data to a .board.json file.
   */
  ipcMain.handle('board:save', async (_event, vaultRoot: string, relativePath: string, data: unknown) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relativePath);
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
      watcher?.suppress(relativePath, 2000);
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
      // Mirrors the pattern added to `vault:copy-file` in Phase 37 / 37.5.
      // `assertWithinVault` below would also catch a traversal, but only
      // after the file has been written outside the vault.
      if (subfolder) assertSafeRelativePath(subfolder);
      // Phase B / B.1 — reject DOS device names (CON, NUL, LPT1, ...) on the
      // board name before `createBoardFile` calls `atomicWriteFile`. Without
      // this gate `CON.board.json` opens a console device handle on Windows
      // and the write either silently no-ops or hangs the IPC. The basename
      // form matches the rename gate at `vault:rename` (Phase 31 A3.6).
      assertSafeFilename(`${name}.board.json`);
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
   * Returns parsed JSON, or the fallback if the file doesn't exist.
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
      return {};
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
      return { app: {}, appearance: {}, defaults: {}, hotkeys: {}, workspace: {}, viewports: {}, sidebarOrder: {} };
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
      // Sprint A / A16 — distinguish parse failure from missing-file. A
      // hand-edited theme that's no longer valid JSON returns an
      // envelope so `refreshAvailable` can aggregate the names of every
      // failing theme into one toast. ENOENT keeps the legacy bare-null
      // shape (the renderer treats it as "theme not found").
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
      assertSafeFilename(name);
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
      // Sprint A / A10 — refuse snapshots of `.filo/` contents. The
      // recovery snapshot path is intended for `.board.json` and vault
      // markdown files; without this gate a renderer could ask main to
      // copy `.filo/tags.json` (or any other config file) into the
      // recovery directory, which is essentially an exfiltration vector
      // for vault-internal state. The dedicated tags/templates/theme
      // channels already own legitimate access to those files.
      assertNotInFiloDir(relativePath);
      const destAbs = await snapshotForRecovery(vaultRoot, relativePath);
      return { ok: true, path: destAbs };
    } catch (err) {
      logMainError(`recovery:snapshot ${relativePath}`, err);
      const code = classifyError(err);
      return { ok: false, ...(code ? { code } : {}), error: String(err) };
    }
  });
}
