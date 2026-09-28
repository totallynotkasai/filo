import type { ThemeId } from '../../shared/types';
import {
  applyBuiltinTheme,
  applyCustomTheme,
  listBuiltinThemes,
  type ThemeFile,
} from '../lib/themes/themeManager';
import { trackComponentWrite } from '../lib/boards/boardSaver';
import { reportError } from '../lib/utils/errorBus';
import { invokeOk } from '../lib/utils/invokeOk';
import { onVaultSwap } from '../core/vaultLifecycle';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { loadedTheme } from '../lib/themes/themeFiles';

/**
 * Theme store — owns the active theme, the catalogue of themes loaded
 * from `.filo/themes/`, and the dispatch through `themeManager` so a
 * single call updates `:root`.
 *
 * Built-in themes (`light`, `dark`, `blueprint`, `retro`, `nature`) are
 * compiled-in constants exposed by `themeManager.listBuiltinThemes()`.
 * Custom themes live as JSON files in `.filo/themes/` (one per theme).
 * Disk is the source of truth for custom themes — there is no
 * in-project catalogue.
 */

const BUILTIN_IDS: readonly ThemeId[] = listBuiltinThemes();
function isBuiltinId(id: string): id is ThemeId {
  return (BUILTIN_IDS as readonly string[]).includes(id);
}

let activeTheme = $state<ThemeId>('light');
/** Active theme file's id (matches the filename without `.json`). */
let activeThemeFileId = $state<string>('light');
/** Theme file IDs available in `.filo/themes/` (without `.json`). */
let availableThemeIds = $state<string[]>([]);
/** Cache of theme files loaded from disk so the UI can render names. */
let themeCache = $state<Record<string, ThemeFile>>({});
/**
 * Session-only flag: when true, subsequent `applyById` / `setBuiltin`
 * calls apply only the system / UI chrome CSS variables, leaving the
 * user's canvas/tile/connection palette intact. Driven by the toggle in
 * the Themes settings panel and NOT persisted across reloads.
 */
let systemOnly = $state<boolean>(false);
/**
 * The built-in theme boards keep while "System colours only" has re-skinned
 * the chrome with another theme (BoardRouter sets it as the board's
 * `data-theme`). Null when the whole app shows one theme.
 */
let boardTheme = $state<ThemeId | null>(null);

/** Records how the theme just painted covers the boards. */
function notePainted(): void {
  boardTheme = systemOnly ? activeTheme : null;
}

export const themeStore = {
  get active() { return activeTheme; },
  get activeFileId() { return activeThemeFileId; },
  get available() { return availableThemeIds; },
  get cache() { return themeCache; },
  get systemOnly() { return systemOnly; },
  get boardTheme() { return boardTheme; },

  setSystemOnly(value: boolean) {
    systemOnly = value;
  },

  /**
   * Lists themes by reading `.filo/themes/`. Hydrates the in-memory
   * cache so subsequent `applyById` calls do not re-hit the disk.
   *
   * JSON parse failures surface a single aggregated toast naming every bad
   * theme file, so a corrupt `.filo/themes/foo.json` doesn't silently vanish
   * from the picker.
   *
   * `reload` names themes to read again even though they are cached: a file
   * another program changed.
   */
  async refreshAvailable(vaultRoot: string, reload: readonly string[] = []): Promise<void> {
    if (!vaultRoot) return;
    // Snapshot identity before the list/load awaits: a swap mid-enumeration
    // must not stamp the outgoing vault's theme catalogue over the incoming
    // vault's reset state. Bail before each state commit.
    const identity = captureVaultIdentity();
    try {
      // `theme:list` is a bare-result channel (returns `unknown[]`).
      // The handler stores filenames as strings; narrow at the boundary.
      const filenames = (await window.filo.invoke('theme:list', vaultRoot)) as string[];
      if (!isStillSameVault(identity)) return;
      const ids = filenames.map((f) => f.replace(/\.json$/i, ''));
      // Only files still on disk stay cached; one deleted elsewhere is dropped.
      const next: Record<string, ThemeFile> = {};
      for (const id of ids) {
        const cached = themeCache[id];
        if (cached && !reload.includes(id)) next[id] = cached;
      }
      const parseFailures: string[] = [];
      const problems: string[] = [];
      for (const id of ids) {
        if (next[id]) continue;
        const loaded = loadedTheme(id, await window.filo.invoke('theme:load', vaultRoot, id));
        if (loaded === 'invalid') {
          parseFailures.push(id);
          continue;
        }
        if (!loaded) continue;
        next[id] = loaded.file;
        if (loaded.problem) problems.push(loaded.problem);
      }
      // Commit `availableThemeIds` + `themeCache` together AFTER the loop so a
      // swap detected mid-loop leaves neither set to the outgoing vault's data.
      if (!isStillSameVault(identity)) return;
      availableThemeIds = ids;
      themeCache = next;
      if (parseFailures.length > 0) {
        const list = parseFailures.map((n) => `"${n}"`).join(', ');
        reportError(
          'theme.parse',
          new Error(`Invalid JSON in theme files: ${list}`),
          `Failed to load theme${parseFailures.length > 1 ? 's' : ''}: ${list} — invalid JSON. Fix the file in .filo/themes/ to make it available again.`,
        );
      }
      if (problems.length > 0) reportError('theme.base', null, problems.join(' '));
    } catch (err) {
      reportError(
        'theme.list',
        err,
        'Failed to enumerate themes from .filo/themes/ — only built-in themes will be available',
      );
    }
  },

  /**
   * Applies a theme by file ID. Built-in IDs short-circuit through
   * `applyBuiltinTheme` (no disk read needed — the CSS `[data-theme]`
   * cascade does the work). Otherwise uses the cached file if available,
   * otherwise loads it from `.filo/themes/`.
   *
   * The short-circuit avoids a spurious ENOENT every time a vault's
   * `appearance.json` carries a base-theme name (e.g. `dark`) rather
   * than a bundled file id (e.g. `dark-mode`): the file `dark.json`
   * doesn't exist, but the builtin path applies cleanly.
   *
   * Never throws. A malformed theme (unknown base) or DOM
   * failure resolves to `{ ok: false, error }`; the caller surfaces the
   * error (toast / openVault failure / etc.) without leaving global
   * state half-mutated. On any failure path the DOM falls back to the
   * built-in 'light' theme so the user is never left looking at unstyled
   * markup.
   */
  async applyById(
    vaultRoot: string,
    themeId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const opts = { systemOnly };
    if (isBuiltinId(themeId)) {
      try {
        applyBuiltinTheme(themeId, opts);
      } catch (err) {
        applyFallbackLight();
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      // In systemOnly mode we don't change `activeTheme` (canvas/tile
      // variables stay on the previous theme), but we still record the
      // file ID so the UI can highlight the chosen card.
      if (!systemOnly) activeTheme = themeId;
      activeThemeFileId = themeId;
      notePainted();
      return { ok: true };
    }
    const identity = captureVaultIdentity();
    let file = themeCache[themeId];
    if (!file && vaultRoot) {
      try {
        const loaded = loadedTheme(themeId, await window.filo.invoke('theme:load', vaultRoot, themeId));
        // A swap during the load await means `themeId` belongs to the outgoing
        // vault; applying it would flash the wrong palette over the new vault
        // (which drives its own theme via `commitFromCandidate`).
        if (!isStillSameVault(identity)) {
          return { ok: false, error: 'vault changed during theme load' };
        }
        // Surface a parse-failure toast distinctly from
        // the generic "not found" path so the user knows the file exists
        // but is malformed. Falls back to built-in light below.
        if (loaded === 'invalid') {
          applyFallbackLight();
          reportError(
            'theme.parse',
            new Error(`Invalid JSON in theme "${themeId}"`),
            `Could not apply theme "${themeId}" — invalid JSON in .filo/themes/${themeId}.json. Falling back to Light theme.`,
          );
          return { ok: false, error: `Theme "${themeId}" has invalid JSON` };
        }
        if (loaded) {
          file = loaded.file;
          themeCache = { ...themeCache, [themeId]: file };
          if (loaded.problem) reportError('theme.base', null, loaded.problem);
        }
      } catch (err) {
        // theme:load IPC failed — fall through to the no-file branch
        // (built-in 'light' fallback below).
        applyFallbackLight();
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (file) {
      try {
        applyCustomTheme(file, opts);
      } catch (err) {
        // Surface a specific toast rather than letting the throw escape to
        // `openVault` as a generic "Failed to open vault". The Light
        // fallback keeps the DOM valid so the vault opens cleanly.
        applyFallbackLight();
        reportError(
          'theme.apply',
          err,
          `Could not apply theme "${themeId}" — falling back to Light theme.`,
        );
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      activeThemeFileId = themeId;
      if (!systemOnly) {
        const base = file.base ?? 'dark';
        activeTheme = base;
      }
      notePainted();
      return { ok: true };
    }
    // File missing (theme:load returned null and the cache had no entry).
    // Apply the built-in 'light' theme so the DOM is in a known state;
    // surface the miss to the caller so it can toast / fail openVault.
    applyFallbackLight();
    return { ok: false, error: `Theme "${themeId}" not found` };
  },

  /**
   * Synchronous commit hook for `loadVaultCandidate`.
   *
   * Installs a pre-fetched theme catalogue (already loaded over IPC by
   * the candidate phase) and applies the chosen active theme to the DOM.
   * Returns `{ ok: false }` on apply failure; callers may surface a toast
   * but `openVault` still treats the swap as successful — the vault is
   * fully open, just with a fallback theme.
   *
   * Built-in active IDs short-circuit (`applyBuiltinTheme`); custom
   * active IDs use the supplied `activeFile` directly with no IPC.
   */
  commitFromCandidate(args: {
    availableIds: string[];
    themeCache: Record<string, ThemeFile>;
    activeId: string;
    activeFile: ThemeFile | null;
  }): { ok: boolean; error?: string } {
    availableThemeIds = args.availableIds.slice();
    themeCache = { ...args.themeCache };
    const opts = { systemOnly };

    if (isBuiltinId(args.activeId)) {
      try {
        applyBuiltinTheme(args.activeId, opts);
      } catch (err) {
        applyFallbackLight();
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!systemOnly) activeTheme = args.activeId;
      activeThemeFileId = args.activeId;
      notePainted();
      return { ok: true };
    }

    if (!args.activeFile) {
      applyFallbackLight();
      return { ok: false, error: `Theme "${args.activeId}" not found` };
    }

    try {
      applyCustomTheme(args.activeFile, opts);
    } catch (err) {
      // Same rationale as `applyById`: an apply throw (invalid `base`,
      // bad variable shape) falls back to Light rather than aborting the
      // whole openVault chain.
      applyFallbackLight();
      reportError(
        'theme.apply',
        err,
        `Could not apply theme "${args.activeId}" — falling back to Light theme.`,
      );
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    activeThemeFileId = args.activeId;
    if (!systemOnly) {
      const base = args.activeFile.base ?? 'dark';
      activeTheme = base;
    }
    notePainted();
    return { ok: true };
  },

  /**
   * Sets the active built-in theme. Convenience wrapper for callers
   * that already know they want a built-in (no async, no IPC).
   */
  setBuiltin(theme: ThemeId) {
    applyBuiltinTheme(theme, { systemOnly });
    if (!systemOnly) activeTheme = theme;
    activeThemeFileId = theme;
    notePainted();
  },

  /**
   * Paints `file` without making it the active theme: the theme editor's
   * live preview. `endPreview` paints the active theme again.
   */
  preview(file: ThemeFile): void {
    applyCustomTheme(file, { systemOnly: false });
    boardTheme = null;
  },

  /** Ends a preview by applying the active theme again. */
  async endPreview(vaultRoot: string): Promise<void> {
    await this.applyById(vaultRoot, activeThemeFileId);
  },

  /**
   * Writes `file` to `.filo/themes/<file.id>.json`, replacing a theme with
   * that id (the caller has checked the name with `themeNameProblem`).
   * Returns the id, or null when the write failed (already toasted).
   */
  async saveTheme(vaultRoot: string, file: ThemeFile): Promise<string | null> {
    if (!vaultRoot || !file.name.trim()) return null;
    const id = file.id;
    const saved = (): void => {
      themeCache = { ...themeCache, [id]: file };
      if (!availableThemeIds.includes(id)) {
        availableThemeIds = [...availableThemeIds, id].sort();
      }
    };
    try {
      await trackComponentWrite(
        vaultRoot,
        `.filo/themes/${id}.json`,
        async () => {
          await invokeOk('theme:save', vaultRoot, id, file);
        },
        // A locked file: Retry saves it again, and leaving keeps a copy.
        { kind: 'config', onFailure: { retry: { rescueText: () => `${JSON.stringify(file, null, 2)}\n`, onSuccess: saved } } },
      );
      saved();
      return id;
    } catch (err) {
      // trackComponentWrite already surfaced the failure via the
      // save-error listener (kind='config' → "Failed to save settings..."
      // toast). Keep this as a triage breadcrumb only — don't reportError
      // or we'd push a second toast for the same disk failure.
      console.error('[themeStore] Failed to save theme:', err);
      return null;
    }
  },

  /**
   * Moves a custom theme file from `.filo/themes/` into Filo's trash
   * (Settings → Trash restores it). The caller has confirmed with the user.
   */
  async deleteTheme(vaultRoot: string, themeId: string): Promise<boolean> {
    if (!vaultRoot) return false;
    try {
      await trackComponentWrite(
        vaultRoot,
        `.filo/themes/${themeId}.json`,
        async () => {
          await invokeOk('theme:delete', vaultRoot, themeId);
        },
        // A delete that didn't happen leaves the theme as it was: nothing unsaved.
        { kind: 'config', onFailure: 'report' },
      );
      const { [themeId]: _removed, ...rest } = themeCache;
      void _removed;
      themeCache = rest;
      availableThemeIds = availableThemeIds.filter((id) => id !== themeId);
      return true;
    } catch (err) {
      // See save-theme above — trackComponentWrite already pushed a toast.
      console.error('[themeStore] Failed to delete theme:', err);
      return false;
    }
  },

  /**
   * Resets in-memory state when a vault closes.
   */
  clear() {
    activeTheme = 'light';
    activeThemeFileId = 'light';
    availableThemeIds = [];
    themeCache = {};
    systemOnly = false;
    boardTheme = null;
  },
};

// ── Helpers ──



/**
 * Last-ditch DOM rescue when a theme apply fails.
 *
 * `applyBuiltinTheme` / `applyCustomTheme` clear the inline `--ui-*`
 * custom properties before they swap `data-theme`. If they throw mid-
 * apply (e.g. an unknown `base` on a hand-edited custom theme), the
 * DOM is left with cleared inline vars and no `data-theme` attribute,
 * which means EVERY CSS var resolves to its `var(...)` fallback — the
 * UI renders against an undefined palette.
 *
 * Calling the built-in 'light' applier as a rescue guarantees the DOM
 * is always in a valid state on every failure path. If THIS also
 * throws (it shouldn't — 'light' is a hard-coded built-in), we swallow
 * the error: returning to `applyById`'s caller is more important than
 * propagating the rescue's own failure.
 */
function applyFallbackLight(): void {
  try {
    applyBuiltinTheme('light', { systemOnly: false });
    activeTheme = 'light';
    activeThemeFileId = 'light';
    boardTheme = null;
  } catch {
    // Built-in 'light' rescue itself failed — there is nothing more we
    // can do at the DOM level. The caller already received { ok: false };
    // higher layers surface a toast.
  }
}


// Vault-swap reset: drops the per-vault custom-theme cache + active-theme tracking so the
// next vault opens against its own `.filo/themes/` directory rather than
// flashing the prior vault's theme while the new one rehydrates.
onVaultSwap('pre-swap', 'theme', () => {
  themeCache = {};
  availableThemeIds = [];
  systemOnly = false;
  boardTheme = null;
  activeTheme = 'light';
  activeThemeFileId = 'light';
});
