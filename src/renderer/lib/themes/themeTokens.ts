/**
 * The colours a theme holds, grouped the way the theme editor shows them.
 *
 * A theme is colours only. Fonts, sizes, UI scales and the toolbar / tab bar
 * colour are settings (`general.*`), so they are never part of a theme: a
 * theme that carried them would erase the user's choice on every switch.
 */

export interface ThemeToken {
  name: string;
  label: string;
}

export interface ThemeTokenGroup {
  id: string;
  label: string;
  tokens: ThemeToken[];
}

function group(id: string, label: string, tokens: Array<[string, string]>): ThemeTokenGroup {
  return { id, label, tokens: tokens.map(([name, tokenLabel]) => ({ name, label: tokenLabel })) };
}

export const THEME_TOKEN_GROUPS: readonly ThemeTokenGroup[] = [
  group('surfaces', 'Backgrounds', [
    ['--ui-bg', 'App background'],
    ['--ui-bg-secondary', 'Secondary background'],
    ['--ui-surface', 'Surface'],
    ['--ui-surface-hover', 'Surface (hover)'],
    ['--ui-surface-active', 'Surface (pressed)'],
    ['--ui-surface-raised', 'Raised surface'],
    ['--modal-bg', 'Dialog'],
    ['--modal-backdrop', 'Dialog backdrop'],
    ['--menu-bg', 'Menu'],
    ['--menu-hover', 'Menu item (hover)'],
    ['--toast-bg', 'Notification'],
  ]),
  group('text', 'Text', [
    ['--text-primary', 'Primary text'],
    ['--text-secondary', 'Secondary text'],
    ['--text-tertiary', 'Hints'],
    ['--text-disabled', 'Disabled text'],
    ['--text-inverse', 'Text on accent'],
    ['--text-on-danger', 'Text on danger'],
  ]),
  group('borders', 'Borders', [
    ['--ui-border', 'Border'],
    ['--ui-border-light', 'Light border'],
    ['--ui-border-focus', 'Focus ring'],
    ['--menu-border', 'Menu border'],
    ['--toast-border', 'Notification border'],
  ]),
  group('accents', 'Accents and status', [
    ['--accent-primary', 'Accent'],
    ['--accent-primary-hover', 'Accent (hover)'],
    ['--accent-primary-alpha', 'Accent tint'],
    ['--accent-secondary', 'Second accent'],
    ['--accent-success', 'Success'],
    ['--accent-info', 'Info'],
    ['--accent-warning', 'Warning'],
    ['--accent-danger', 'Danger'],
    ['--accent-danger-hover', 'Danger (hover)'],
    ['--status-error-alpha', 'Error tint'],
    ['--menu-danger', 'Menu danger text'],
    ['--menu-danger-bg', 'Menu danger tint'],
    ['--ui-warn-bg', 'Warning banner'],
    ['--ui-warn-bg-hover', 'Warning banner (hover)'],
    ['--ui-warn-border', 'Warning banner border'],
    ['--ui-warn-text', 'Warning banner text'],
    ['--selection-bg', 'Selection'],
    ['--selection-border', 'Selection border'],
  ]),
  group('chrome', 'Toolbar, tabs and sidebar', [
    ['--toolbar-bg', 'Toolbar'],
    ['--toolbar-border', 'Toolbar border'],
    ['--toolbar-divider', 'Toolbar divider'],
    ['--toolbar-save-ok', 'Save status: saved'],
    ['--toolbar-save-busy', 'Save status: saving'],
    ['--toolbar-save-error', 'Save status: failed'],
    ['--toolbar-save-attention', 'Save status: waiting'],
    ['--tabbar-bg', 'Tab bar'],
    ['--tabbar-border', 'Tab bar border'],
    ['--tab-active-bg', 'Active tab'],
    ['--tab-hover-bg', 'Tab (hover)'],
    ['--sidebar-bg', 'Sidebar'],
    ['--sidebar-border', 'Sidebar border'],
    ['--scrollbar-track', 'Scrollbar track'],
    ['--scrollbar-thumb', 'Scrollbar'],
    ['--scrollbar-thumb-hover', 'Scrollbar (hover)'],
  ]),
  group('canvas', 'Canvas, tiles and frames', [
    ['--canvas-bg', 'Canvas'],
    ['--canvas-pattern', 'Canvas pattern'],
    ['--tile-header-bg', 'Tile header'],
    ['--tile-body-bg', 'Tile body'],
    ['--tile-border', 'Tile border'],
    ['--frame-header-text', 'Frame title'],
    ['--frame-header-text-muted', 'Frame title (muted)'],
    ['--frame-selected-glow', 'Selected frame'],
    ['--frame-resize-handle', 'Frame resize handle'],
    ['--frame-header-btn-hover-bg', 'Frame button (hover)'],
    ['--frame-header-btn-hover-border', 'Frame button border (hover)'],
    ['--frame-header-btn-danger', 'Frame delete button'],
    ['--frame-header-btn-danger-bg', 'Frame delete tint'],
  ]),
  group('connections', 'Connections', [
    ['--connection-path-color', 'Path'],
    ['--connection-arrow-color', 'Arrow'],
    ['--connection-label-color', 'Label text'],
    ['--connection-label-bg', 'Label background'],
    ['--connection-label-border', 'Label border'],
    ['--connection-label-hover-border', 'Label border (hover)'],
    ['--connection-label-editing-border', 'Label border (editing)'],
    ['--connection-label-text-primary', 'Label menu text'],
    ['--connection-label-text-secondary', 'Label menu hints'],
    ['--connection-label-btn-hover-bg', 'Label button (hover)'],
    ['--connection-label-btn-danger', 'Label delete button'],
    ['--connection-label-btn-danger-bg', 'Label delete tint'],
    ['--connection-bubble-fill', 'Handle fill'],
    ['--connection-bubble-stroke', 'Handle outline'],
    ['--connection-bubble-stroke-hover', 'Handle outline (hover)'],
    ['--connection-bubble-stroke-active', 'Handle outline (dragging)'],
    ['--connection-path-hover-glow', 'Path glow (hover)'],
    ['--connection-drawing-stroke', 'Path being drawn'],
  ]),
  group('priorities', 'Task priorities', [
    ['--priority-urgent', 'Urgent'],
    ['--priority-high', 'High'],
    ['--priority-medium', 'Medium'],
    ['--priority-low', 'Low'],
  ]),
];

/**
 * Tokens a theme holds but the editor doesn't offer a colour for: shadows are
 * full `box-shadow` values, not colours. A snapshot still carries them so a
 * theme keeps its depth.
 */
export const THEME_SHADOW_TOKENS: readonly string[] = [
  '--ui-shadow', '--ui-shadow-lg', '--ui-shadow-elevated',
  '--toolbar-shadow', '--connection-label-shadow',
];

/** Every token a theme file holds, colours and shadows. */
export const THEME_TOKEN_NAMES: readonly string[] = [
  ...THEME_TOKEN_GROUPS.flatMap((g) => g.tokens.map((t) => t.name)),
  ...THEME_SHADOW_TOKENS,
];

/**
 * Variables that are the user's settings, written onto `:root` by App.svelte
 * (font, sizes, UI scales). A theme never sets them; one saved by an older
 * version that carries them has them skipped on apply.
 */
export const SETTINGS_VAR_NAMES: readonly string[] = [
  '--font-system', '--font-size-base',
  '--ui-toolbar-scale', '--ui-board-toolbar-scale', '--ui-tabbar-scale',
  '--ui-minimap-scale', '--ui-waypoint-scale',
  '--global-toolbar-height', '--tabbar-height',
];
