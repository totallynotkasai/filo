import { z } from 'zod';
import { ArrowTypeSchema, BackgroundPatternSchema, BorderStyleSchema, PathTypeSchema, ShapeSchema } from './styleEnums';
import { GENERAL_SETTINGS_DEFAULTS as GD } from '../../shared/generalSettingsDefaults';

/**
 * Tile default styles used when creating new tiles.
 *
 * `dynamicContrastText` is the Dynamic Contrast Text override
 * (design doc V5 §625): when true, the renderer overrides text colour to
 * pure black or white based on background luminance (WCAG AA). Cascades
 * per-element > board > global like every other style field.
 */
const TileDefaultsSchema = z.object({
  headerColor: z.string().default(''),
  bodyColor: z.string().default(''),
  borderColor: z.string().default(''),
  shape: ShapeSchema.default('rounded'),
  borderStyle: BorderStyleSchema.default('solid'),
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
  pathType: PathTypeSchema.default('curved'),
  pathStyle: BorderStyleSchema.default('solid'),
  arrowType: ArrowTypeSchema.default('none'),
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
  borderStyle: BorderStyleSchema.default('solid'),
  borderWidth: z.number().min(0).max(10).default(1),
  shape: ShapeSchema.default('rounded'),
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
  borderStyle: BorderStyleSchema.default('solid'),
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
  borderStyle: BorderStyleSchema.default('solid'),
  borderWidth: z.number().min(0).max(10).default(1),
  shape: ShapeSchema.default('rounded'),
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
  borderStyle: BorderStyleSchema.default('solid'),
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
  borderStyle: BorderStyleSchema.default('solid'),
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
  borderStyle: BorderStyleSchema.default('solid'),
  borderWidth: z.number().min(0).max(10).default(1),
  shadowIntensity: z.number().min(0).max(1).default(0.2),
  dynamicContrastText: z.boolean().default(true),
});

// ── Per-board-type defaults ──

export const MindMapDefaultsSchema = z.object({
  backgroundColor: z.string().default(''),
  backgroundPattern: BackgroundPatternSchema.default('grid'),
  tile: TileDefaultsSchema.prefault({}),
  connectionPath: ConnectionPathDefaultsSchema.prefault({}),
  connectionLabel: ConnectionLabelDefaultsSchema.prefault({}),
  frame: FrameDefaultsSchema.prefault({}),
});

export const KanbanDefaultsSchema = z.object({
  backgroundColor: z.string().default(''),
  backgroundPattern: BackgroundPatternSchema.default('none'),
  accentColor: z.string().default(''),
  column: ColumnDefaultsSchema.prefault({}),
  card: CardDefaultsSchema.prefault({}),
});

export const TaskListDefaultsSchema = z.object({
  backgroundColor: z.string().default(''),
  backgroundPattern: BackgroundPatternSchema.default('none'),
  accentColor: z.string().default(''),
  task: TaskDefaultsSchema.prefault({}),
  section: TaskSectionDefaultsSchema.prefault({}),
});

export const DocumentDefaultsSchema = z.object({
  backgroundColor: z.string().default(''),
  backgroundPattern: BackgroundPatternSchema.default('none'),
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
  tileTitle: z.number().min(8).max(48).default(GD.defaultBoardFontSize.tileTitle),
  tileBody: z.number().min(8).max(48).default(GD.defaultBoardFontSize.tileBody),
  connectionLabel: z.number().min(8).max(32).default(GD.defaultBoardFontSize.connectionLabel),
  frameTitle: z.number().min(8).max(48).default(GD.defaultBoardFontSize.frameTitle),
  kanbanColumnTitle: z.number().min(8).max(48).default(GD.defaultBoardFontSize.kanbanColumnTitle),
  kanbanCardTitle: z.number().min(8).max(48).default(GD.defaultBoardFontSize.kanbanCardTitle),
  kanbanCardBody: z.number().min(8).max(48).default(GD.defaultBoardFontSize.kanbanCardBody),
  taskListTitle: z.number().min(8).max(48).default(GD.defaultBoardFontSize.taskListTitle),
  taskItem: z.number().min(8).max(48).default(GD.defaultBoardFontSize.taskItem),
  /** Default body font-size for task placements. Paired with `taskItem` (which is the title size) so "Apply to all" can write both layers. */
  taskItemBody: z.number().min(8).max(48).default(GD.defaultBoardFontSize.taskItemBody),
  /** Default title font-size for task-list section headers. */
  taskSectionTitle: z.number().min(8).max(48).default(GD.defaultBoardFontSize.taskSectionTitle),
}).prefault({});

/**
 * Per-object-type toggle controlling whether action buttons are revealed on
 * hover/focus (`true`) or kept permanently visible (`false`). Defaults match
 * today's hover-reveal behaviour across all six surfaces.
 */
const HoverButtonsSchema = z.object({
  tiles: z.boolean().default(GD.hoverButtons.tiles),
  cards: z.boolean().default(GD.hoverButtons.cards),
  tasks: z.boolean().default(GD.hoverButtons.tasks),
  frames: z.boolean().default(GD.hoverButtons.frames),
  connectionLabels: z.boolean().default(GD.hoverButtons.connectionLabels),
  columns: z.boolean().default(GD.hoverButtons.columns),
}).prefault({});

export const GeneralSettingsSchema = z.object({
  globalFont: z.string().default(GD.globalFont),
  /**
   * Base font size (px) for system chrome — toolbar, sidebar, tab bar,
   * modals, dropdowns. Drives the `--font-size-base` CSS variable.
   */
  globalFontSize: z.number().min(10).max(20).default(GD.globalFontSize),
  /**
   * Line spacing of a note that sets none of its own (frontmatter
   * `lineSpacing:` wins). The same range a note's own value may take.
   */
  defaultLineSpacing: z.number().min(0.8).max(4).default(GD.defaultLineSpacing),
  /**
   * Defaults for board-element text. See `DefaultBoardFontSizeSchema`.
   */
  defaultBoardFontSize: DefaultBoardFontSizeSchema,
  systemFonts: z
    .array(z.string())
    .default(() => [...GD.systemFonts]),
  /**
   * Per-surface UI scale factors (1.0 = 100%). Range 0.5–2.0, default 1.0.
   * Wired into CSS via `--ui-toolbar-scale`, `--ui-board-toolbar-scale`,
   * `--ui-tabbar-scale`, `--ui-minimap-scale`, `--ui-waypoint-scale`.
   */
  globalToolbarScale: z.number().min(0.5).max(2.0).default(GD.globalToolbarScale),
  boardToolbarScale: z.number().min(0.5).max(2.0).default(GD.boardToolbarScale),
  tabBarScale: z.number().min(0.5).max(2.0).default(GD.tabBarScale),
  minimapScale: z.number().min(0.5).max(2.0).default(GD.minimapScale),
  waypointScale: z.number().min(0.5).max(2.0).default(GD.waypointScale),
  toolbarColor: z.string().default(GD.toolbarColor),
  tabBarColor: z.string().default(GD.tabBarColor),
  radarEnabled: z.boolean().default(GD.radarEnabled),
  /**
   * Recently-used colours shown above the colour picker presets. Capped
   * at 8 to match the picker's two-row grid (`ColorPicker.svelte` slices
   * to 8 and uses `grid-template-columns: repeat(8, 1fr)`).
   */
  recentColors: z.array(z.string()).max(8).default(() => [...GD.recentColors]),
  /**
   * Per-board undo/redo stack size. The default of 500 covers the long
   * tail of "I refactored the board and want to step back" without growing
   * memory unboundedly — each Command is small but a tile-delete snapshots
   * the body, so 5000 is the upper bound. The historyStore reads this via
   * `setMaxHistory` from the App-level settings $effect.
   */
  historyLimit: z.number().int().min(10).max(5000).default(GD.historyLimit),
  /**
   * Vault-relative path of the folder that receives newly-created tiles
   * and files dropped onto the board. Empty string means use the vault
   * root. Toggled per-folder via the tree-icon button in the vault
   * sidebar; persisted to .filo/app.json.
   */
  activeRootFolder: z.string().default(GD.activeRootFolder),
  /**
   * When true, the vault sidebar shows the full filename including the
   * extension (e.g. `Notes.md`); when false, the extension is hidden for
   * a cleaner look. Rename inputs always show the full name regardless.
   */
  showFileExtensions: z.boolean().default(GD.showFileExtensions),
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
  sidebarSortField: z.enum(['none', 'name', 'modified', 'type', 'size']).default(GD.sidebarSortField),
  sidebarSortDirection: z.enum(['asc', 'desc']).default(GD.sidebarSortDirection),
  sidebarGroupField: z.enum(['none', 'name', 'modified', 'type', 'size']).default(GD.sidebarGroupField),
  sidebarGroupDirection: z.enum(['asc', 'desc']).default(GD.sidebarGroupDirection),
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
