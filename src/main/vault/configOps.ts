import { promises as fs } from 'fs';
import { join } from 'path';
import { atomicWriteFile, ensureDir, pathExists } from './filenameUtils';
import { assertSafeFilename } from '../utils/pathSecurity';
import { PAYLOAD_LIMITS } from '../utils/payloadLimits';

/**
 * Vault configuration file operations.
 *
 * All vault-wide settings live in `.filo/` as individual JSON files:
 *   .filo/app.json           — Core app settings (toolbar, fonts, radar)
 *   .filo/appearance.json    — Active theme, font, CSS snippet toggles
 *   .filo/defaults.json      — Board-type defaults (tile, connection, frame styles)
 *   .filo/hotkeys.json       — Custom keyboard shortcut overrides
 *   .filo/workspace.json     — Layout state (open tabs, sidebar, split panes)
 *   .filo/viewports.json     — Per-board camera (pan + zoom), keyed by boardId
 *   .filo/sidebar-order.json — User-defined sidebar order for Sort By "None"
 *                              (keyed by parent folder absolute path)
 */

const CONFIG_DIR = '.filo';

export type ConfigFile =
  | 'app.json'
  | 'appearance.json'
  | 'defaults.json'
  | 'hotkeys.json'
  | 'workspace.json'
  | 'viewports.json'
  | 'sidebar-order.json';

const CONFIG_FILES = new Set<ConfigFile>([
  'app.json',
  'appearance.json',
  'defaults.json',
  'hotkeys.json',
  'workspace.json',
  'viewports.json',
  'sidebar-order.json',
]);

export function isConfigFile(name: string): name is ConfigFile {
  return CONFIG_FILES.has(name as ConfigFile);
}

// ── Paths ──

function configFilePath(vaultRoot: string, file: ConfigFile): string {
  return join(vaultRoot, CONFIG_DIR, file);
}

export function configDirPath(vaultRoot: string): string {
  return join(vaultRoot, CONFIG_DIR);
}

export function themesDirPath(vaultRoot: string): string {
  return join(vaultRoot, CONFIG_DIR, 'themes');
}

export function fontsDirPath(vaultRoot: string): string {
  return join(vaultRoot, CONFIG_DIR, 'fonts');
}

export function snippetsDirPath(vaultRoot: string): string {
  return join(vaultRoot, CONFIG_DIR, 'snippets');
}

// ── Initialize ──

/**
 * Creates the .filo/ directory structure with default config files.
 * Existing files are NOT overwritten.
 */
export async function initVaultConfig(vaultRoot: string): Promise<void> {
  const configDir = configDirPath(vaultRoot);
  await ensureDir(configDir);
  await ensureDir(themesDirPath(vaultRoot));
  await ensureDir(fontsDirPath(vaultRoot));
  await ensureDir(snippetsDirPath(vaultRoot));

  // Create default config files if they don't exist.
  //
  // `app.json` mirrors the field set produced by `configWriteScheduler` so
  // a freshly initialised vault has the same shape on disk that subsequent
  // saves will produce — no missing-then-appearing keys. Field defaults
  // here MUST match `GeneralSettingsSchema` defaults in
  // `src/renderer/schema/settings.ts`; the schema can't be imported across
  // the main/renderer boundary, so this object is the manual mirror.
  const defaults: Record<ConfigFile, unknown> = {
    'app.json': {
      globalFont: 'Inter, system-ui, sans-serif',
      globalFontSize: 13,
      defaultBoardFontSize: {
        tileTitle: 14,
        tileBody: 13,
        connectionLabel: 12,
        frameTitle: 15,
        kanbanColumnTitle: 14,
        kanbanCardTitle: 13,
        kanbanCardBody: 12,
        taskListTitle: 16,
        taskItem: 13,
      },
      systemFonts: ['Inter', 'Arial', 'Georgia', 'Courier New', 'Verdana'],
      globalToolbarScale: 1,
      boardToolbarScale: 1,
      tabBarScale: 1,
      minimapScale: 1,
      waypointScale: 1,
      toolbarColor: '',
      tabBarColor: '',
      radarEnabled: true,
      recentColors: [],
      activeRootFolder: '',
      sidebarSortField: 'none',
      sidebarSortDirection: 'asc',
      sidebarGroupField: 'none',
      sidebarGroupDirection: 'asc',
      showFileExtensions: false,
      hoverButtons: {
        tiles: true,
        cards: true,
        tasks: true,
        frames: true,
        connectionLabels: true,
        columns: true,
      },
    },
    'appearance.json': {
      activeTheme: 'light',
      font: 'Inter, system-ui, sans-serif',
      snippets: [],
    },
    'defaults.json': {
      mindmap: {},
      kanban: {},
      tasklist: {},
      document: {},
    },
    'hotkeys.json': {},
    'workspace.json': {
      openTabs: [],
      vaultSidebar: { open: true, width: 260 },
      rightSidebar: { open: false, width: 300, activeTab: 'backlinks' },
      sideToolbar: { position: 'right', pinned: true },
    },
    'viewports.json': {},
    'sidebar-order.json': {},
  };

  for (const [file, defaultData] of Object.entries(defaults)) {
    const filePath = configFilePath(vaultRoot, file as ConfigFile);
    if (!(await pathExists(filePath))) {
      await atomicWriteFile(filePath, JSON.stringify(defaultData, null, 2));
    }
  }
}

// ── Read ──

/**
 * Sentinel object returned by `loadConfig` when the file exists on disk but
 * couldn't be parsed (syntax error, double-stringified payload that
 * un-wraps to garbage, etc.). The renderer recognises the `__corrupt`
 * marker, surfaces a blocking modal, and disables the debounced save for
 * that file until the user resolves the choice — otherwise the next save
 * would silently overwrite the user's hand-edited config with whatever
 * the in-memory store happens to hold.
 *
 * Caller pattern in the renderer:
 *   if (raw && typeof raw === 'object' && (raw as { __corrupt?: unknown }).__corrupt) { ... }
 */
export interface CorruptConfig {
  __corrupt: true;
  raw: string;
  error: string;
}

export function isCorruptConfig(value: unknown): value is CorruptConfig {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __corrupt?: unknown }).__corrupt === true
  );
}

/**
 * Reads a config file from .filo/ and returns parsed JSON.
 *
 * Distinguishes the four load outcomes (Phase 23 M21):
 *   - File missing (ENOENT) → returns `fallback`. This is the normal
 *     bootstrap path: a freshly created vault has no `.filo/` configs yet.
 *   - File exists and parses → returns the parsed payload.
 *   - File exists but fails to parse → returns a `CorruptConfig` sentinel
 *     so the renderer can surface a blocking modal and disable the
 *     debounced writer for that file. The renderer MUST NOT treat a
 *     corrupt config as if it were a fresh-vault default — that would
 *     silently rewrite the user's hand-edited file with the in-memory
 *     bootstrap shape.
 *   - EACCES / EBUSY / EPERM (transient lock — Windows Defender, antivirus,
 *     dropbox indexer mid-scan) → retry once after 500 ms before treating
 *     as corrupt. A stealth AV lock that holds the file for ~50–200 ms
 *     used to permanently disable the writer for that session because
 *     the second branch treated it as parse-error-class corruption.
 *
 * Legacy unwrap: pre-fix builds wrote configs double-stringified (the
 * renderer JSON.stringified the payload, then saveConfig JSON.stringified
 * it again). A first parse on those files yields a string, so we detect
 * that and JSON.parse a second time so existing vaults keep loading. If
 * the inner parse fails, that's a true corruption — surface it as such
 * rather than silently dropping to the fallback.
 */
const TRANSIENT_READ_RETRY_MS = 500;
const TRANSIENT_READ_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Phase 8 / 8.1 — stat-then-read with a per-channel size cap. A hand-edited
 * (or corrupted) JSON file pointed at the wrong content type could be many
 * GB; reading it would buffer the whole thing into memory before the
 * downstream JSON.parse rejects it. The pre-stat aborts that case with a
 * typed error the caller can translate into a `CorruptConfig` sentinel so
 * the renderer's safety gate (no silent overwrite of unreadable config)
 * applies to oversize files too.
 */
export class ConfigFileTooLargeError extends Error {
  readonly code = 'FILE_TOO_LARGE';
  readonly byteLength: number;
  readonly maxBytes: number;
  constructor(byteLength: number, maxBytes: number, label: string) {
    super(`${label} is ${byteLength} bytes; cap is ${maxBytes} bytes`);
    this.name = 'ConfigFileTooLargeError';
    this.byteLength = byteLength;
    this.maxBytes = maxBytes;
  }
}

async function statAndAssertSize(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<void> {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) {
    throw new ConfigFileTooLargeError(stat.size, maxBytes, label);
  }
}

async function readConfigWithTransientRetry(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !TRANSIENT_READ_CODES.has(code)) throw err;
    // Brief retry — common AV / sync-client lock windows are 50–200 ms.
    await delay(TRANSIENT_READ_RETRY_MS);
    return fs.readFile(filePath, 'utf-8');
  }
}

export async function loadConfig<T>(
  vaultRoot: string,
  file: ConfigFile,
  fallback: T,
): Promise<T | CorruptConfig> {
  const filePath = configFilePath(vaultRoot, file);
  // Phase 8 / 8.1 — refuse to read configs that exceed the per-channel cap.
  // Treated as `__corrupt` (not fallback) so the renderer keeps the existing
  // safety behaviour: a too-large file shouldn't silently be replaced with
  // bootstrap defaults.
  try {
    await statAndAssertSize(filePath, PAYLOAD_LIMITS.CONFIG, `config:load ${file}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    if (err instanceof ConfigFileTooLargeError) {
      return { __corrupt: true, raw: '', error: String(err) };
    }
    throw err;
  }
  let raw: string;
  try {
    raw = await readConfigWithTransientRetry(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    // Any other read error (still locked after one retry, hard I/O failure)
    // — surface as corrupt so the renderer doesn't silently overwrite.
    return {
      __corrupt: true,
      raw: '',
      error: String(err),
    };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string') {
      try {
        return JSON.parse(parsed) as T;
      } catch (innerErr) {
        return { __corrupt: true, raw, error: String(innerErr) };
      }
    }
    return parsed as T;
  } catch (parseErr) {
    return { __corrupt: true, raw, error: String(parseErr) };
  }
}

/**
 * Convenience loaders for each config file.
 */
export async function loadAppConfig(vaultRoot: string) {
  return loadConfig(vaultRoot, 'app.json', {});
}

export async function loadAppearanceConfig(vaultRoot: string) {
  return loadConfig(vaultRoot, 'appearance.json', {});
}

export async function loadDefaultsConfig(vaultRoot: string) {
  return loadConfig(vaultRoot, 'defaults.json', {});
}

export async function loadHotkeysConfig(vaultRoot: string) {
  return loadConfig(vaultRoot, 'hotkeys.json', {});
}

export async function loadWorkspaceConfig(vaultRoot: string) {
  return loadConfig(vaultRoot, 'workspace.json', {});
}

export async function loadViewportsConfig(vaultRoot: string) {
  return loadConfig(vaultRoot, 'viewports.json', {});
}

export async function loadSidebarOrderConfig(vaultRoot: string) {
  return loadConfig(vaultRoot, 'sidebar-order.json', {});
}

// ── Write ──

/**
 * Writes a config file to .filo/ using atomic write.
 *
 * The renderer passes a pre-serialized JSON string (the boardSaver layer
 * does its own `JSON.stringify` so it can dedupe against
 * `lastWrittenConfigs`). If we `JSON.stringify` again we end up writing
 * `"{\n...\n}"` — a JSON string literal containing JSON — which then
 * `loadConfig` parses to a string instead of an object, silently
 * dropping every config field on the next vault open. Detect a string
 * input and write it directly.
 */
export async function saveConfig(
  vaultRoot: string,
  file: ConfigFile,
  data: unknown,
): Promise<void> {
  await ensureDir(configDirPath(vaultRoot));
  const filePath = configFilePath(vaultRoot, file);
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, json);
}

/**
 * Convenience savers for each config file.
 */
export async function saveAppConfig(vaultRoot: string, data: unknown) {
  return saveConfig(vaultRoot, 'app.json', data);
}

export async function saveAppearanceConfig(vaultRoot: string, data: unknown) {
  return saveConfig(vaultRoot, 'appearance.json', data);
}

export async function saveDefaultsConfig(vaultRoot: string, data: unknown) {
  return saveConfig(vaultRoot, 'defaults.json', data);
}

export async function saveHotkeysConfig(vaultRoot: string, data: unknown) {
  return saveConfig(vaultRoot, 'hotkeys.json', data);
}

export async function saveWorkspaceConfig(vaultRoot: string, data: unknown) {
  return saveConfig(vaultRoot, 'workspace.json', data);
}

export async function saveViewportsConfig(vaultRoot: string, data: unknown) {
  return saveConfig(vaultRoot, 'viewports.json', data);
}

export async function saveSidebarOrderConfig(vaultRoot: string, data: unknown) {
  return saveConfig(vaultRoot, 'sidebar-order.json', data);
}

// ── Themes ──

/**
 * Lists all theme files in .filo/themes/.
 * Returns an array of theme filenames (e.g., ['dark-mode.json', 'custom-theme.json']).
 */
export async function listThemes(vaultRoot: string): Promise<string[]> {
  const dir = themesDirPath(vaultRoot);
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(e => e.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/**
 * Sprint A / A16 — dedicated error class for theme JSON parse failures.
 * Distinct from ENOENT (file simply doesn't exist) and unknown errors
 * (permission, IO) so the IPC layer can return a specific envelope and
 * the renderer can surface a "theme X is invalid JSON" toast instead of
 * silently treating the theme as missing.
 */
export class ThemeParseError extends Error {
  constructor(public readonly themeName: string, cause: unknown) {
    super(`Invalid JSON in theme "${themeName}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ThemeParseError';
  }
}

/**
 * Loads a theme file from .filo/themes/.
 *
 * `themeName` is validated as a bare filename (no `..`, no path separators)
 * to defend against IPC callers passing a traversal payload — even if the
 * IPC-layer guard is removed or bypassed, the disk operation here stays
 * contained to `.filo/themes/`.
 *
 * Sprint A / A16 — JSON parse failures throw `ThemeParseError` (not the
 * unnamed SyntaxError that `JSON.parse` produces). The handler in
 * `board.ipc.ts:theme:load` distinguishes this from ENOENT so the
 * renderer can surface a toast naming the bad theme rather than silently
 * pretending the theme doesn't exist.
 */
export async function loadTheme(vaultRoot: string, themeName: string): Promise<unknown> {
  assertSafeFilename(themeName);
  const filePath = join(themesDirPath(vaultRoot), `${themeName}.json`);
  // Phase 8 / 8.1 — pre-stat against `PAYLOAD_LIMITS.THEME` so a hand-rolled
  // multi-MB blob in `.filo/themes/` aborts before the entire file is
  // buffered into memory.
  await statAndAssertSize(filePath, PAYLOAD_LIMITS.THEME, `theme:load ${themeName}`);
  const raw = await fs.readFile(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ThemeParseError(themeName, err);
  }
}

/**
 * Saves a theme file to .filo/themes/.
 *
 * Defence-in-depth: `assertSafeFilename` is also called at the IPC layer, but
 * we re-validate here so any future call site (test harness, scripts) stays
 * containment-safe without depending on its caller.
 */
export async function saveTheme(
  vaultRoot: string,
  themeName: string,
  data: unknown,
): Promise<void> {
  assertSafeFilename(themeName);
  await ensureDir(themesDirPath(vaultRoot));
  const filePath = join(themesDirPath(vaultRoot), `${themeName}.json`);
  const json = JSON.stringify(data, null, 2);
  await atomicWriteFile(filePath, json);
}

/**
 * Deletes a theme file from .filo/themes/.
 */
export async function deleteTheme(vaultRoot: string, themeName: string): Promise<void> {
  assertSafeFilename(themeName);
  const filePath = join(themesDirPath(vaultRoot), `${themeName}.json`);
  await fs.unlink(filePath);
}

