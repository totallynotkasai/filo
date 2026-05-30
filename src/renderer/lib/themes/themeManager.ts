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

/** Every CSS custom property a Filo theme may set. Used to drive cleanup. */
export type ThemeVariableMap = Record<string, string>;

/**
 * Phase 5 — inline-validates a single variable before writing it. The
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
 * Canonical list of system-only variable names. Used to read computed
 * values from a sandbox `[data-theme]` element when applying a built-in
 * theme in `systemOnly` mode — because `getComputedStyle` cannot
 * enumerate CSS custom properties by prefix.
 *
 * Keep in sync with the `[data-theme]` blocks in `src/css/style.css`.
 * Adding a new system variable to the CSS without adding it here means
 * the system-only path will leave it on the previous value.
 */
export const SYSTEM_VAR_NAMES: readonly string[] = [
  // Base surfaces
  '--ui-bg', '--ui-bg-secondary', '--ui-surface', '--ui-surface-hover',
  '--ui-surface-active', '--ui-surface-raised',
  '--ui-border', '--ui-border-light', '--ui-border-focus',
  '--ui-shadow', '--ui-shadow-lg', '--ui-shadow-elevated',
  // Text
  '--text-primary', '--text-secondary', '--text-tertiary',
  '--text-disabled', '--text-inverse', '--text-on-danger',
  // Accents / status
  '--accent-primary', '--accent-primary-hover', '--accent-primary-alpha',
  '--accent-secondary',
  '--accent-warning', '--accent-danger', '--accent-danger-hover',
  '--accent-success', '--accent-info',
  '--status-error-alpha',
  // Chrome regions
  '--toolbar-bg', '--toolbar-border', '--toolbar-shadow', '--toolbar-divider',
  '--tabbar-bg', '--tabbar-border', '--tab-active-bg', '--tab-hover-bg',
  '--sidebar-bg', '--sidebar-border',
  '--menu-bg', '--menu-border', '--menu-hover', '--menu-danger', '--menu-danger-bg',
  '--modal-backdrop', '--modal-bg',
  '--toast-bg', '--toast-border',
  '--scrollbar-track', '--scrollbar-thumb', '--scrollbar-thumb-hover',
  '--selection-bg', '--selection-border',
];

/**
 * Variables that belong to canvas / board content — every shipped theme
 * redefines these per palette, so saving a "current settings as theme"
 * snapshot needs to capture them or the saved theme will fall back to
 * dark-mode defaults on the next apply.
 *
 * Stays in sync with the `[data-theme]` blocks in `src/css/style.css`.
 */
const CONTENT_VAR_NAMES: readonly string[] = [
  // Canvas
  '--canvas-bg', '--canvas-pattern',
  // Tile
  '--tile-header-bg', '--tile-body-bg', '--tile-border',
  // Connection palette (path + label + bubbles + hover)
  '--connection-path-color', '--connection-arrow-color', '--connection-label-color',
  '--connection-bubble-fill', '--connection-bubble-stroke',
  '--connection-bubble-stroke-hover', '--connection-bubble-stroke-active',
  '--connection-path-hover-glow', '--connection-drawing-stroke',
  '--connection-label-bg', '--connection-label-border', '--connection-label-shadow',
  '--connection-label-hover-border', '--connection-label-editing-border',
  '--connection-label-text-secondary', '--connection-label-text-primary',
  '--connection-label-btn-hover-bg', '--connection-label-btn-danger',
  '--connection-label-btn-danger-bg',
  // Frame chrome — varies per theme; omitting these makes a re-applied
  // saved theme fall back to the base theme's frame palette (P2.13).
  '--frame-selected-glow', '--frame-header-text', '--frame-header-text-muted',
  '--frame-header-btn-hover-bg', '--frame-header-btn-hover-border',
  '--frame-header-btn-danger', '--frame-header-btn-danger-bg',
  '--frame-resize-handle',
  // Priority palette (Kanban / Task List)
  '--priority-urgent', '--priority-high', '--priority-medium', '--priority-low',
];

/**
 * Per-vault user choices that App.svelte / AppShell.svelte write inline
 * onto `:root` (NOT per-theme defaults). Capturing these inside a
 * custom-theme snapshot lets "save current as theme" reflect what the
 * user is actually seeing — globalFontSize, scale sliders, etc. — so a
 * re-applied saved theme restores the same look.
 */
const USER_OVERRIDE_VAR_NAMES: readonly string[] = [
  '--font-system', '--font-size-base',
  '--ui-toolbar-scale', '--ui-board-toolbar-scale', '--ui-tabbar-scale',
  '--ui-minimap-scale', '--ui-waypoint-scale',
  '--global-toolbar-height', '--tabbar-height',
];

/**
 * The complete set of CSS custom properties that "Save current settings
 * as theme" should capture — system + content + user-overrides. Themes
 * are still CSS-variable-only by design (ProjectSettings-level values
 * like default board font sizes can't be saved into a theme), but every
 * variable that drives the visible palette is in this list.
 */
export const THEME_VAR_NAMES: readonly string[] = [
  ...SYSTEM_VAR_NAMES,
  ...CONTENT_VAR_NAMES,
  ...USER_OVERRIDE_VAR_NAMES,
];

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
 * Reads the system-only variable values from a built-in theme without
 * touching `:root`'s `data-theme`. Used by `applyBuiltinTheme` in
 * `systemOnly` mode so the user's canvas/tile/connection palette stays
 * on its previous values.
 */
function readBuiltinSystemVars(theme: ThemeId): ThemeVariableMap {
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
    for (const name of SYSTEM_VAR_NAMES) {
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
  const vars = readBuiltinSystemVars(theme);
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
  const root = getRootElement();
  if (!root) return;
  const base = theme.base ?? 'dark';
  // Sprint B / B17 — validate the base BEFORE we drop the previously
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
    if (opts.systemOnly && !isSystemVar(prop)) continue;
    if (applySafeThemeVar(root, prop, value)) {
      appliedCustomProps.push(prop);
    }
  }
}

/**
 * Returns the list of built-in theme IDs in canonical order.
 */
export function listBuiltinThemes(): readonly ThemeId[] {
  return ALL_BUILTIN_THEMES;
}

/**
 * Test/teardown helper — clears any inline custom-theme variables
 * without touching `data-theme`. Exposed so unit tests can isolate.
 */
export function resetThemeManager(): void {
  clearAppliedCustomProps();
}
