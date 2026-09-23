import { z } from 'zod';

/**
 * Tile default styles used when creating new tiles.
 *
 * `dynamicContrastText` is the Phase 4 Dynamic Contrast Text override
 * (design doc V5 §625): when true, the renderer overrides text colour to
 * pure black or white based on background luminance (WCAG AA). Cascades
 * per-element > board > global like every other style field.
 */
const TileDefaultsSchema = z.object({
  headerColor: z.string().default(''),
  bodyColor: z.string().default(''),
  borderColor: z.string().default(''),
  shape: z.enum(['rectangle', 'rounded']).default('rounded'),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).default('solid'),
  borderWidth: z.number().min(0).max(10).default(1),
  shadowIntensity: z.number().min(0).max(1).default(0.3),
  dynamicContrastText: z.boolean().default(true),
  fontSizeTitle: z.number().min(8).max(48).optional(),
  fontSizeBody: z.number().min(8).max(48).optional(),
});

/**
 * Connection path default styles.
 */
const ConnectionPathDefaultsSchema = z.object({
  pathColor: z.string().default(''),
  pathSize: z.number().min(1).max(10).default(2),
  pathType: z.enum(['curved', 'straight', 'elbow', 'smart']).default('curved'),
  pathStyle: z.enum(['solid', 'dashed', 'dotted']).default('solid'),
  arrowType: z.enum(['none', 'start', 'end', 'both']).default('none'),
  arrowColor: z.string().default(''),
  arrowSize: z.number().min(4).max(24).default(10),
});

/**
 * Connection label default styles.
 *
 * `defaultText` is the seed string applied to new connection labels and
 * lives in settings only (it's a creation seed, not a cascade style).
 * `textColor`, `backgroundColor`, and `fontSize` are cascade-resolvable
 * via `effectiveConnectionLabelStyle` — per-connection overrides win
 * over board and global. `fontSize` is optional with no default so a
 * fully-unset cascade falls through to the CSS variable.
 */
const ConnectionLabelDefaultsSchema = z.object({
  defaultText: z.string().default(''),
  textColor: z.string().default(''),
  backgroundColor: z.string().default(''),
  fontSize: z.number().min(8).max(32).optional(),
});

/**
 * Frame default styles.
 */
const FrameDefaultsSchema = z.object({
  // Empty defaults so freshly-created frames render fully transparent — body
  // and header fall through to `transparent` rather than `var(--ui-surface)`.
  // The frame's border + title text keep it findable on the canvas.
  headerColor: z.string().default(''),
  bodyColor: z.string().default(''),
  backgroundImage: z.string().default(''),
  backgroundOpacity: z.number().min(0).max(1).default(1),
  borderColor: z.string().default(''),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).default('solid'),
  borderWidth: z.number().min(0).max(10).default(1),
  shape: z.enum(['rectangle', 'rounded']).default('rounded'),
  shadowIntensity: z.number().min(0).max(1).default(0.3),
  dynamicContrastText: z.boolean().default(true),
  fontSizeTitle: z.number().min(8).max(48).optional(),
});

/**
 * Column defaults for Kanban boards.
 */
const ColumnDefaultsSchema = z.object({
  headerColor: z.string().default(''),
  bodyColor: z.string().default(''),
  borderColor: z.string().default(''),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).default('solid'),
  borderWidth: z.number().min(0).max(10).default(1),
  shadowIntensity: z.number().min(0).max(1).default(0.3),
  dynamicContrastText: z.boolean().default(true),
  /** Default column width in px. Per-column `style.width` overrides this. */
  width: z.number().min(120).max(2000).default(380),
  fontSizeTitle: z.number().min(8).max(48).optional(),
  /** Default accent colour for columns. Empty string falls through to
   *  the board-level `settings.accentColor`. */
  accent: z.string().default(''),
});

/**
 * Card defaults for Kanban boards.
 */
const CardDefaultsSchema = z.object({
  backgroundColor: z.string().default(''),
  /** Default header band background. Empty = inherit theme `--tile-header-bg`. */
  headerColor: z.string().default(''),
  /** Default body content background. Empty = inherit theme `--tile-body-bg`. */
  bodyColor: z.string().default(''),
  borderColor: z.string().default(''),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).default('solid'),
  borderWidth: z.number().min(0).max(10).default(1),
  shape: z.enum(['rectangle', 'rounded']).default('rounded'),
  shadowIntensity: z.number().min(0).max(1).default(0.2),
  dynamicContrastText: z.boolean().default(true),
  fontSizeTitle: z.number().min(8).max(48).optional(),
  fontSizeBody: z.number().min(8).max(48).optional(),
});

/**
 * Task defaults for Task List boards.
 */
const TaskDefaultsSchema = z.object({
  headerColor: z.string().default(''),
  bodyColor: z.string().default(''),
  borderColor: z.string().default(''),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).default('solid'),
  borderWidth: z.number().min(0).max(10).default(1),
  shadowIntensity: z.number().min(0).max(1).default(0.2),
  dynamicContrastText: z.boolean().default(true),
  fontSizeTitle: z.number().min(8).max(48).optional(),
  fontSizeBody: z.number().min(8).max(48).optional(),
});

/**
 * Task-section defaults for Task List boards. Sections style themselves
 * independently of tasks because users typically want a heavier visual
 * weight on the section header (border-color and a larger title font).
 */
const TaskSectionDefaultsSchema = z.object({
  headerColor: z.string().default(''),
  bodyColor: z.string().default(''),
  borderColor: z.string().default(''),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).default('solid'),
  borderWidth: z.number().min(0).max(10).default(1),
  shadowIntensity: z.number().min(0).max(1).default(0.2),
  dynamicContrastText: z.boolean().default(true),
  fontSizeTitle: z.number().min(8).max(48).optional(),
});

/**
 * Document element defaults.
 */
const DocumentElementDefaultsSchema = z.object({
  headerColor: z.string().default(''),
  bodyColor: z.string().default(''),
  borderColor: z.string().default(''),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).default('solid'),
  borderWidth: z.number().min(0).max(10).default(1),
  shadowIntensity: z.number().min(0).max(1).default(0.2),
  dynamicContrastText: z.boolean().default(true),
});

// ── Per-board-type defaults ──

export const MindMapDefaultsSchema = z.object({
  backgroundColor: z.string().default(''),
  backgroundPattern: z.enum(['grid', 'dots', 'lines', 'none']).default('grid'),
  tile: TileDefaultsSchema.prefault({}),
  connectionPath: ConnectionPathDefaultsSchema.prefault({}),
  connectionLabel: ConnectionLabelDefaultsSchema.prefault({}),
  frame: FrameDefaultsSchema.prefault({}),
});

export const KanbanDefaultsSchema = z.object({
  backgroundColor: z.string().default(''),
  backgroundPattern: z.enum(['grid', 'dots', 'lines', 'none']).default('none'),
  accentColor: z.string().default(''),
  column: ColumnDefaultsSchema.prefault({}),
  card: CardDefaultsSchema.prefault({}),
});

export const TaskListDefaultsSchema = z.object({
  backgroundColor: z.string().default(''),
  backgroundPattern: z.enum(['grid', 'dots', 'lines', 'none']).default('none'),
  accentColor: z.string().default(''),
  task: TaskDefaultsSchema.prefault({}),
  section: TaskSectionDefaultsSchema.prefault({}),
});

export const DocumentDefaultsSchema = z.object({
  backgroundColor: z.string().default(''),
  backgroundPattern: z.enum(['grid', 'dots', 'lines', 'none']).default('none'),
  accentColor: z.string().default(''),
  document: DocumentElementDefaultsSchema.prefault({}),
});

// ── General settings ──

/**
 * Default sizes for board-element text. Each field is the default
 * `font-size` (in px) used to seed newly created elements: the element
 * factory bakes the current value into the element's per-element style
 * override at creation time. Per-element overrides win via the existing
 * style cascade; changing a default does NOT affect already-existing
 * elements. The "Apply to all Existing Items" button in
 * `GeneralSettings.svelte` walks the project and writes the current
 * defaults onto every existing element as a per-element override.
 */
const DefaultBoardFontSizeSchema = z.object({
  tileTitle: z.number().min(8).max(48).default(14),
  tileBody: z.number().min(8).max(48).default(13),
  connectionLabel: z.number().min(8).max(32).default(12),
  frameTitle: z.number().min(8).max(48).default(15),
  kanbanColumnTitle: z.number().min(8).max(48).default(14),
  kanbanCardTitle: z.number().min(8).max(48).default(13),
  kanbanCardBody: z.number().min(8).max(48).default(12),
  taskListTitle: z.number().min(8).max(48).default(16),
  taskItem: z.number().min(8).max(48).default(13),
  /** Default body font-size for task placements. Paired with `taskItem` (which is the title size) so "Apply to all" can write both layers. */
  taskItemBody: z.number().min(8).max(48).default(12),
  /** Default title font-size for task-list section headers. */
  taskSectionTitle: z.number().min(8).max(48).default(14),
}).prefault({});

/**
 * Per-object-type toggle controlling whether action buttons are revealed on
 * hover/focus (`true`) or kept permanently visible (`false`). Defaults match
 * today's hover-reveal behaviour across all six surfaces.
 */
const HoverButtonsSchema = z.object({
  tiles: z.boolean().default(true),
  cards: z.boolean().default(true),
  tasks: z.boolean().default(true),
  frames: z.boolean().default(true),
  connectionLabels: z.boolean().default(true),
  columns: z.boolean().default(true),
}).prefault({});

export const GeneralSettingsSchema = z.object({
  globalFont: z.string().default('Inter, system-ui, sans-serif'),
  /**
   * Base font size (px) for system chrome — toolbar, sidebar, tab bar,
   * modals, dropdowns. Drives the `--font-size-base` CSS variable.
   */
  globalFontSize: z.number().min(10).max(20).default(13),
  /**
   * Defaults for board-element text. See `DefaultBoardFontSizeSchema`.
   */
  defaultBoardFontSize: DefaultBoardFontSizeSchema,
  systemFonts: z
    .array(z.string())
    .default(() => ['Inter', 'Arial', 'Georgia', 'Courier New', 'Verdana']),
  /**
   * Per-surface UI scale factors (1.0 = 100%). Range 0.5–2.0, default 1.0.
   * Wired into CSS via `--ui-toolbar-scale`, `--ui-board-toolbar-scale`,
   * `--ui-tabbar-scale`, `--ui-minimap-scale`, `--ui-waypoint-scale`.
   */
  globalToolbarScale: z.number().min(0.5).max(2.0).default(1.0),
  boardToolbarScale: z.number().min(0.5).max(2.0).default(1.0),
  tabBarScale: z.number().min(0.5).max(2.0).default(1.0),
  minimapScale: z.number().min(0.5).max(2.0).default(1.0),
  waypointScale: z.number().min(0.5).max(2.0).default(1.0),
  toolbarColor: z.string().default(''),
  tabBarColor: z.string().default(''),
  radarEnabled: z.boolean().default(true),
  /**
   * Recently-used colours shown above the colour picker presets. Capped
   * at 8 to match the picker's two-row grid (`ColorPicker.svelte` slices
   * to 8 and uses `grid-template-columns: repeat(8, 1fr)`).
   */
  recentColors: z.array(z.string()).max(8).default(() => []),
  /**
   * Per-board undo/redo stack size (M23). The default of 500 covers the long
   * tail of "I refactored the board and want to step back" without growing
   * memory unboundedly — each Command is small but a tile-delete snapshots
   * the body, so 5000 is the upper bound. The historyStore reads this via
   * `setMaxHistory` from the App-level settings $effect.
   */
  historyLimit: z.number().int().min(10).max(5000).default(500),
  /**
   * Vault-relative path of the folder that receives newly-created tiles
   * and files dropped onto the board. Empty string means use the vault
   * root. Toggled per-folder via the tree-icon button in the vault
   * sidebar; persisted to .filo/app.json.
   */
  activeRootFolder: z.string().default(''),
  /**
   * When true, the vault sidebar shows the full filename including the
   * extension (e.g. `Notes.md`); when false, the extension is hidden for
   * a cleaner look. Rename inputs always show the full name regardless.
   */
  showFileExtensions: z.boolean().default(false),
  /**
   * Vault sidebar sort + group settings. Sort is the primary ordering
   * field; Group acts as a secondary sort within equal primary values
   * (no visual bucket headers). Folders always sort by name regardless
   * of the active sort field — mtime/size are meaningless for folders.
   *
   * `sidebarSortField: 'none'` disables ordering and uses the persisted
   * manual order (drag-and-drop in the sidebar). This is the new default
   * so a fresh vault opens in whatever order the user arranges.
   */
  sidebarSortField: z.enum(['none', 'name', 'modified', 'type', 'size']).default('none'),
  sidebarSortDirection: z.enum(['asc', 'desc']).default('asc'),
  sidebarGroupField: z.enum(['none', 'name', 'modified', 'type', 'size']).default('none'),
  sidebarGroupDirection: z.enum(['asc', 'desc']).default('asc'),
  hoverButtons: HoverButtonsSchema,
}).passthrough();

// ── Project settings root ──

export const ProjectSettingsSchema = z.object({
  general: GeneralSettingsSchema.prefault({}),
  mindmap: MindMapDefaultsSchema.prefault({}),
  kanban: KanbanDefaultsSchema.prefault({}),
  tasklist: TaskListDefaultsSchema.prefault({}),
  document: DocumentDefaultsSchema.prefault({}),
}).passthrough();

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/**
 * Returns a fully-populated `ProjectSettings` object built entirely from
 * schema defaults. Centralised so callers that need a fresh defaults snapshot
 * (vault load fallback, "Apply Theme Defaults to all Boards", tests) all go
 * through one path and can't drift apart when a new sub-schema is added.
 *
 * Note: every sub-schema is declared with `.prefault({})` (Zod 4: the
 * default input is parsed through the sub-schema so its inner field defaults
 * apply — a plain `.default({})` would return a bare `{}`), so `parse({})`
 * always succeeds without surprises. If a future field is added without a
 * default it will throw here at startup rather than producing a partial
 * settings object that fails downstream consumers in obscure ways.
 */
export function defaultProjectSettings(): ProjectSettings {
  return ProjectSettingsSchema.parse({});
}
export type GeneralSettings = z.infer<typeof GeneralSettingsSchema>;
export type MindMapDefaults = z.infer<typeof MindMapDefaultsSchema>;
export type KanbanDefaults = z.infer<typeof KanbanDefaultsSchema>;
export type TaskListDefaults = z.infer<typeof TaskListDefaultsSchema>;
export type DocumentDefaults = z.infer<typeof DocumentDefaultsSchema>;
