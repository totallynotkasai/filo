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

export const themeStore = {
  get active() { return activeTheme; },
  get activeFileId() { return activeThemeFileId; },
  get available() { return availableThemeIds; },
  get cache() { return themeCache; },
  get systemOnly() { return systemOnly; },

  setSystemOnly(value: boolean) {
    systemOnly = value;
  },

  /**
   * Lists themes by reading `.filo/themes/`. Hydrates the in-memory
   * cache so subsequent `applyById` calls do not re-hit the disk.
   *
   * Sprint A / A16 — JSON parse failures surface a single aggregated toast
   * naming every bad theme file. Previously parse failures were silently
   * downgraded to a null return at the IPC layer, indistinguishable from
   * "theme is a built-in", so a corrupt `.filo/themes/foo.json` would
   * disappear from the picker without explanation.
   */
  async refreshAvailable(vaultRoot: string): Promise<void> {
    if (!vaultRoot) return;
    // Audit-11 VS-4 — snapshot identity before the list/load awaits. A swap
    // mid-enumeration must not stamp the OUTGOING vault's theme catalogue over
    // the pre-swap reset (which already cleared `availableThemeIds`/`themeCache`
    // for the incoming vault). Visual-only, but a stale catalogue flashes the
    // wrong themes in the picker. Bail before each state commit.
    const identity = captureVaultIdentity();
    try {
      // `theme:list` is a bare-result channel (returns `unknown[]`).
      // The handler stores filenames as strings; narrow at the boundary.
      const filenames = (await window.filo.invoke('theme:list', vaultRoot)) as string[];
      if (!isStillSameVault(identity)) return;
      const ids = filenames.map((f) => f.replace(/\.json$/i, ''));
      const next: Record<string, ThemeFile> = { ...themeCache };
      const parseFailures: string[] = [];
      for (const id of ids) {
        if (next[id]) continue;
        const data = (await window.filo.invoke('theme:load', vaultRoot, id)) as
          | ThemeFile
          | { ok: false; code: 'invalid-json'; name?: string }
          | null;
        if (isThemeParseFailure(data)) {
          parseFailures.push(id);
          continue;
        }
        if (data) next[id] = data;
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
   * Phase R4 — never throws. A malformed theme (unknown base) or DOM
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
      return { ok: true };
    }
    const identity = captureVaultIdentity();
    let file = themeCache[themeId];
    if (!file && vaultRoot) {
      try {
        const loaded = (await window.filo.invoke('theme:load', vaultRoot, themeId)) as
          | ThemeFile
          | { ok: false; code: 'invalid-json'; name?: string }
          | null;
        // Audit-11 VS-4 — a swap during the load await means `themeId` belongs
        // to the outgoing vault; applying it to the DOM (or seeding the cache)
        // would flash the wrong palette over the freshly-opened vault. Bail
        // without applying — the new vault drives its own theme via
        // `commitFromCandidate`.
        if (!isStillSameVault(identity)) {
          return { ok: false, error: 'vault changed during theme load' };
        }
        // Sprint A / A16 — surface a parse-failure toast distinctly from
        // the generic "not found" path so the user knows the file exists
        // but is malformed. Falls back to built-in light below.
        if (isThemeParseFailure(loaded)) {
          applyFallbackLight();
          reportError(
            'theme.parse',
            new Error(`Invalid JSON in theme "${themeId}"`),
            `Could not apply theme "${themeId}" — invalid JSON in .filo/themes/${themeId}.json. Falling back to Light theme.`,
          );
          return { ok: false, error: `Theme "${themeId}" has invalid JSON` };
        }
        if (loaded) {
          file = loaded;
          themeCache = { ...themeCache, [themeId]: file };
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
        // Sprint A / A15 — surface the failure via the error bus so the
        // user sees "Could not apply theme 'foo' — using Light fallback"
        // instead of the generic "Failed to open vault" toast that used
        // to fire when the throw escaped to `openVault`. The DOM is
        // already pulled back to the built-in Light theme by the
        // applyFallbackLight() rescue, so the vault opens cleanly.
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
      return { ok: true };
    }
    // File missing (theme:load returned null and the cache had no entry).
    // Apply the built-in 'light' theme so the DOM is in a known state;
    // surface the miss to the caller so it can toast / fail openVault.
    applyFallbackLight();
    return { ok: false, error: `Theme "${themeId}" not found` };
  },

  /**
   * Phase R4 — synchronous commit hook for `loadVaultCandidate`.
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
      return { ok: true };
    }

    if (!args.activeFile) {
      applyFallbackLight();
      return { ok: false, error: `Theme "${args.activeId}" not found` };
    }

    try {
      applyCustomTheme(args.activeFile, opts);
    } catch (err) {
      // Sprint A / A15 — same rationale as `applyById`. The vault-open
      // candidate commit lands here when `openVault` pre-resolves the
      // theme; if the apply throws (invalid `base`, custom variable
      // shape), surface the error and fall back to Light rather than
      // aborting the whole openVault chain with a generic "Failed to
      // open vault" message.
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
  },

  /**
   * Saves the current ProjectSettings as a named theme JSON file in
   * `.filo/themes/`. The file ID is derived from the slugified name.
   * Returns the file ID on success, or null if no vault is open.
   *
   * Format mirrors `ThemeFile`: a `variables` map of CSS custom
   * properties extracted from current settings. Today the function
   * does not infer `--ui-*` variables from arbitrary user-chosen
   * tile/connection colours (those live in per-element style); it
   * captures only the explicit theme-level settings the user can edit
   * via the Settings panel.
   */
  async saveCurrentAsTheme(
    vaultRoot: string,
    name: string,
    variables: Record<string, string>,
    base?: ThemeId,
  ): Promise<string | null> {
    if (!vaultRoot || !name.trim()) return null;
    const id = slugify(name);
    const file: ThemeFile = {
      id,
      name: name.trim(),
      base: base ?? activeTheme,
      variables,
    };
    try {
      await trackComponentWrite(
        vaultRoot,
        `.filo/themes/${id}.json`,
        async () => {
          await invokeOk('theme:save', vaultRoot, id, file);
        },
        'config',
      );
      themeCache = { ...themeCache, [id]: file };
      if (!availableThemeIds.includes(id)) {
        availableThemeIds = [...availableThemeIds, id].sort();
      }
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
   * Deletes a theme file from `.filo/themes/`. Built-in themes are
   * not protected at this layer — the caller decides whether to allow
   * deleting them (built-ins are compiled-in constants, so deleting the
   * file just removes the user's customization).
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
        'config',
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
  },
};

// ── Helpers ──

/**
 * Sprint A / A16 — type guard for the `{ ok: false, code: 'invalid-json' }`
 * envelope the main-side `theme:load` handler returns when a theme file
 * exists on disk but isn't valid JSON. Bare `null` (legacy: ENOENT or
 * unknown error) doesn't match; only the explicit parse-failure envelope.
 */
function isThemeParseFailure(value: unknown): value is { ok: false; code: 'invalid-json'; name?: string } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.ok === false && v.code === 'invalid-json';
}


/**
 * Phase R4 — last-ditch DOM rescue when a theme apply fails.
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
  } catch {
    // Built-in 'light' rescue itself failed — there is nothing more we
    // can do at the DOM level. The caller already received { ok: false };
    // higher layers surface a toast.
  }
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'theme';
}

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Drops the per-vault custom-theme cache + active-theme tracking so the
// next vault opens against its own `.filo/themes/` directory rather than
// flashing the prior vault's theme while the new one rehydrates.
onVaultSwap('pre-swap', 'theme', () => {
  themeCache = {};
  availableThemeIds = [];
  systemOnly = false;
  activeTheme = 'light';
  activeThemeFileId = 'light';
});
