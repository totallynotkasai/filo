/**
 * Theme manager — single place that applies a theme by writing `--ui-*`
 * variables onto `:root`. Every component reads colours via CSS custom
 * properties (defined in `src/css/style.css` under `[data-theme='X']`),
 * never via inline colours, so swapping a theme propagates instantly.
 *
 * Two paths exist:
 *
 *   1. Built-in themes (`light`, `dark`, `blueprint`, `retro`, `nature`)
 *      are defined in `style.css` as `[data-theme='X']` blocks. Activating
 *      one is a one-liner: set `data-theme` on `<html>`. Custom variables
 *      from a previous custom theme are cleared so they cannot leak.
 *
 *   2. Custom themes (loaded from `.filo/themes/{name}.json`) ship as a
 *      flat `{ "--ui-bg": "#...", "--ui-surface": "#...", ... }` map.
 *      Activating one writes each entry directly onto
 *      `document.documentElement.style`, overriding the built-in cascade.
 *      The base `data-theme` is kept so any variable the custom theme does
 *      *not* override falls back to the built-in value rather than going
 *      undefined.
 */
import type { ThemeId } from '../../../shared/types';
import { asSafeThemeValue } from '../../../shared/untrusted';
import { reportError } from '../utils/errorBus';
import { themeVersion } from '../../stores/themeVersion.svelte';
import { SETTINGS_VAR_NAMES, THEME_TOKEN_NAMES } from './themeTokens';

/** Every CSS custom property a Filo theme may set. Used to drive cleanup. */
export type ThemeVariableMap = Record<string, string>;

/**
 * Inline-validates a single variable before writing it. The
 * `asSafeThemeValue` sanitiser rejects CSS-injection patterns (`url(…)`,
 * `expression(`, `image(`, `@import`) and over-long / unparsable values.
 * A vault-shipped theme JSON containing `'red; background-image:
 * url(https://evil.example/p)'` would otherwise inject an external-
 * resource fetch via CSS — info-leak.
 *
 * Dropped variables fire a devtools breadcrumb but no toast — a
 * malformed theme JSON may carry dozens of bad keys and toast-spamming
 * the user buys nothing.
 */
function applySafeThemeVar(
  root: HTMLElement,
  prop: string,
  rawValue: string,
): boolean {
  const safe = asSafeThemeValue(rawValue);
  if (safe === null) { reportError('themeManager', null, `Dropped theme variable "${prop}"`); return false; }
  root.style.setProperty(prop, safe);
  return true;
}

/**
 * Shape of a theme JSON file stored in `.filo/themes/`.
 *
 * `base` (optional) names a built-in theme to inherit from. The base's
 * `[data-theme]` block stays applied so any variable the custom theme
 * omits resolves to the built-in fallback.
 */
export interface ThemeFile {
  id: string;
  name: string;
  base?: ThemeId;
  variables: ThemeVariableMap;
}

const ALL_BUILTIN_THEMES: readonly ThemeId[] = ['light', 'dark', 'blueprint', 'retro', 'nature'];

/**
 * Variable-name prefixes considered "system / UI chrome" — toolbar,
 * sidebar, tab bar, modals, menus, scrollbars, body/text/accent colours
 * and all their shadows. Everything else (canvas, tile, connection) is
 * "board content" and is left alone in `systemOnly` mode.
 */
const SYSTEM_VAR_PREFIXES: readonly string[] = [
  '--ui-',
  '--text-',
  '--accent-',
  '--toolbar-',
  '--tabbar-',
  '--tab-',
  '--sidebar-',
  '--menu-',
  '--modal-',
  '--toast-',
  '--scrollbar-',
  '--selection-',
  '--status-',
];

function isSystemVar(prop: string): boolean {
  return SYSTEM_VAR_PREFIXES.some((p) => prop.startsWith(p));
}

/**
 * The system-only variable names: every theme token that styles chrome.
 * Used to read computed values from a sandbox `[data-theme]` element when
 * applying a built-in theme in `systemOnly` mode, because `getComputedStyle`
 * cannot enumerate CSS custom properties by prefix.
 */
export const SYSTEM_VAR_NAMES: readonly string[] = THEME_TOKEN_NAMES.filter(isSystemVar);

/**
 * Every CSS custom property a theme holds (`lib/themes/themeTokens.ts`). The
 * user's font, sizes and scales are not among them: those are settings.
 */
export const THEME_VAR_NAMES: readonly string[] = THEME_TOKEN_NAMES;

const SETTINGS_VARS: ReadonlySet<string> = new Set(SETTINGS_VAR_NAMES);

/**
 * Tracks which CSS custom properties are currently set inline by the
 * theme manager so we can wipe them cleanly when the user switches
 * themes. Without this we'd leak old variables (e.g. retro's
 * `--accent-warning`) into a freshly applied custom theme.
 */
let appliedCustomProps: string[] = [];

function getRootElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.documentElement;
}

function clearAppliedCustomProps(): void {
  const root = getRootElement();
  if (!root) {
    appliedCustomProps = [];
    return;
  }
  for (const prop of appliedCustomProps) {
    root.style.removeProperty(prop);
  }
  appliedCustomProps = [];
}

/**
 * Reads a built-in theme's values for `names` without touching `:root`'s
 * `data-theme`. `applyBuiltinTheme` in `systemOnly` mode reads the system
 * variables this way, so the user's canvas/tile/connection palette stays on
 * its previous values; Duplicate on a built-in theme reads all of them.
 */
export function readBuiltinThemeVariables(
  theme: ThemeId,
  names: readonly string[] = THEME_VAR_NAMES,
): ThemeVariableMap {
  const root = getRootElement();
  if (!root) return {};
  // A detached element does not pick up parent CSS, so the sandbox is
  // appended to `<html>` long enough to read computed values, then
  // removed. Hidden via `display:none` so it never paints.
  const sandbox = document.createElement('div');
  sandbox.setAttribute('data-theme', theme);
  sandbox.style.display = 'none';
  root.appendChild(sandbox);
  try {
    const computed = getComputedStyle(sandbox);
    const out: ThemeVariableMap = {};
    for (const name of names) {
      const v = computed.getPropertyValue(name).trim();
      if (v) out[name] = v;
    }
    return out;
  } finally {
    root.removeChild(sandbox);
  }
}

/**
 * Applies a built-in theme. Wipes any previously applied custom-theme
 * inline variables so the `[data-theme]` cascade fully takes over.
 *
 * `opts.systemOnly`: when true, leave `data-theme` and the board-content
 * variables (--canvas-*, --tile-*, --connection-*) untouched and only
 * overwrite the system / UI chrome variables. Lets the user re-skin the
 * toolbar/sidebar/menus without losing a custom tile palette.
 */
export function applyBuiltinTheme(
  theme: ThemeId,
  opts: { systemOnly?: boolean } = {},
): void {
  try {
    paintBuiltinTheme(theme, opts);
  } finally {
    themeVersion.bump();
  }
}

function paintBuiltinTheme(theme: ThemeId, opts: { systemOnly?: boolean }): void {
  const root = getRootElement();
  clearAppliedCustomProps();
  if (!root) return;
  if (!ALL_BUILTIN_THEMES.includes(theme)) {
    throw new Error(`Unknown built-in theme: ${theme}`);
  }
  if (!opts.systemOnly) {
    root.setAttribute('data-theme', theme);
    return;
  }
  // System-only: don't touch data-theme (would replace canvas vars).
  // Inline the system vars instead, tracked so the next switch cleans up.
  const vars = readBuiltinThemeVariables(theme, SYSTEM_VAR_NAMES);
  for (const [prop, value] of Object.entries(vars)) {
    // Built-in theme values come from `getComputedStyle` against our own
    // CSS, so they're trusted — but routing through the same sanitiser
    // keeps the sink monoculture and lets a future CSP / hash-pin
    // verify both code paths in one place.
    if (applySafeThemeVar(root, prop, value)) {
      appliedCustomProps.push(prop);
    }
  }
}

/**
 * Applies a custom theme loaded from `.filo/themes/{id}.json`. Sets the
 * base built-in theme first (so unset variables fall back), then writes
 * each variable inline on `:root`.
 *
 * `opts.systemOnly`: when true, skips the `data-theme` base swap and
 * filters the theme's variables to system / UI chrome only, leaving the
 * user's canvas/tile/connection palette intact.
 */
export function applyCustomTheme(
  theme: ThemeFile,
  opts: { systemOnly?: boolean } = {},
): void {
  try {
    paintCustomTheme(theme, opts);
  } finally {
    themeVersion.bump();
  }
}

function paintCustomTheme(theme: ThemeFile, opts: { systemOnly?: boolean }): void {
  const root = getRootElement();
  if (!root) return;
  const base = theme.base ?? 'dark';
  // Validate the base BEFORE we drop the previously
  // applied vars. If we cleared first and then threw, the page would be
  // stuck between two themes — the inline overrides gone, but the
  // `data-theme` attribute (and thus the base palette) still pointing at
  // the previous theme's choice. The caller's catch can fall back to a
  // built-in theme cleanly only when the previous theme is still painted.
  if (!ALL_BUILTIN_THEMES.includes(base)) {
    throw new Error(`Custom theme "${theme.id}" has unknown base: ${base}`);
  }
  clearAppliedCustomProps();
  if (!opts.systemOnly) {
    root.setAttribute('data-theme', base);
  }
  for (const [prop, value] of Object.entries(theme.variables)) {
    if (!prop.startsWith('--')) continue;
    // A theme saved by an older version carries the user's font, size and
    // scales; applying them would override the settings, and the next switch
    // would clear them back to the stylesheet's.
    if (SETTINGS_VARS.has(prop)) continue;
    if (opts.systemOnly && !isSystemVar(prop)) continue;
    if (applySafeThemeVar(root, prop, value)) {
      appliedCustomProps.push(prop);
    }
  }
}

/**
 * The theme colours on screen now, read off `:root`: the active theme,
 * built-in or custom. A theme variable that something other than a theme set
 * inline (App.svelte writes the user's toolbar and tab bar colour settings
 * there) is read from under that override, so a new theme doesn't capture a
 * setting.
 */
export function snapshotThemeVariables(): ThemeVariableMap {
  const root = getRootElement();
  if (!root) return {};
  const lifted: Array<[string, string]> = [];
  for (const name of THEME_VAR_NAMES) {
    if (appliedCustomProps.includes(name)) continue;
    const inline = root.style.getPropertyValue(name);
    if (!inline) continue;
    lifted.push([name, inline]);
    root.style.removeProperty(name);
  }
  try {
    const computed = getComputedStyle(root);
    const out: ThemeVariableMap = {};
    for (const name of THEME_VAR_NAMES) {
      const v = computed.getPropertyValue(name).trim();
      if (v) out[name] = v;
    }
    return out;
  } finally {
    for (const [name, value] of lifted) applySafeThemeVar(root, name, value);
  }
}

/**
 * Returns the list of built-in theme IDs in canonical order.
 */
export function listBuiltinThemes(): readonly ThemeId[] {
  return ALL_BUILTIN_THEMES;
}

/**
 * Clears any inline custom-theme variables without touching `data-theme`, so
 * unit tests start from no applied custom theme. Nothing in the app calls it.
 */
export function __resetThemeManagerForTests(): void {
  clearAppliedCustomProps();
}
