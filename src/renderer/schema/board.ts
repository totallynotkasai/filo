import { z } from 'zod';
import { ACCENT_COLOR } from '../constants/defaults';
import {
  TilePlacementSchema,
  InlineTileSchema,
  KanbanTilePlacementSchema,
  TaskPlacementSchema,
} from './placement';
import { uniqueBy, uniqueStrings, idString } from './schemaUtils';

/**
 * Per-board override blocks for the style cascade.
 *
 * Every field is optional: fields that are unset defer to the global
 * `ProjectSettings` defaults via `resolveStyle`. The shape mirrors the
 * corresponding `*DefaultsSchema` in `settings.ts` so the Settings
 * modal's "Current Board" tab can reuse the same controls.
 *
 * Kept inline in this file (rather than imported from `settings.ts`)
 * to avoid a circular import — `settings.ts` already pulls in nothing
 * from here, and keeping the schemas simple lets us iterate on them
 * without threading changes through two files.
 *
 * No `.passthrough()` on these internal partial-style / defaults blocks:
 * they're consumed exclusively by the in-process cascade resolver, so
 * unknown keys would only accumulate as dead weight on disk. Forward-
 * compat lives on the outer board envelopes instead — see the DECISION
 * comment on `BoardSchema`. This is deliberate: a newer Filo's style key is
 * meaningless to an older cascade resolver, and the only loss is a
 * newer→older→save downgrade round-trip. Do NOT add `.passthrough()` here
 * without re-opening that decision.
 */
const PartialTileStyleSchema = z.object({
  headerColor: z.string().optional(),
  bodyColor: z.string().optional(),
  borderColor: z.string().optional(),
  shape: z.enum(['rectangle', 'rounded']).optional(),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  // .finite() + bounds matching the corresponding defaults schema in
  // settings.ts, so a hand-edited override can't feed Infinity (or other
  // out-of-range values) into the style cascade.
  shadowIntensity: z.number().finite().min(0).max(1).optional(),
  dynamicContrastText: z.boolean().optional(),
  fontSizeTitle: z.number().min(8).max(48).optional(),
  fontSizeBody: z.number().min(8).max(48).optional(),
});

const PartialConnectionPathStyleSchema = z.object({
  pathColor: z.string().optional(),
  // Bounds mirror `ConnectionSchema.pathSize` / `arrowSize`
  // so a per-board path-size override can't smuggle a 1000-px arrow into
  // the renderer.
  pathSize: z.number().finite().min(1).max(10).optional(),
  pathType: z.enum(['curved', 'straight', 'elbow', 'smart']).optional(),
  pathStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  arrowType: z.enum(['none', 'start', 'end', 'both']).optional(),
  arrowColor: z.string().optional(),
  arrowSize: z.number().finite().min(4).max(24).optional(),
});

const PartialConnectionLabelStyleSchema = z.object({
  defaultText: z.string().optional(),
  textColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fontSize: z.number().min(8).max(32).optional(),
});

const PartialFrameStyleBlockSchema = z.object({
  headerColor: z.string().optional(),
  bodyColor: z.string().optional(),
  backgroundImage: z.string().optional(),
  // Bounds mirror `FrameStyleSchema.backgroundOpacity` /
  // `shadowIntensity` (both 0..1) so the partial-override layer can't
  // smuggle Infinity into the cascade.
  backgroundOpacity: z.number().finite().min(0).max(1).optional(),
  borderColor: z.string().optional(),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  shape: z.enum(['rectangle', 'rounded']).optional(),
  shadowIntensity: z.number().finite().min(0).max(1).optional(),
  dynamicContrastText: z.boolean().optional(),
  fontSizeTitle: z.number().min(8).max(48).optional(),
});

const PartialColumnStyleSchema = z.object({
  headerColor: z.string().optional(),
  bodyColor: z.string().optional(),
  borderColor: z.string().optional(),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  // Bounds mirror `ColumnDefaultsSchema` in settings.ts.
  shadowIntensity: z.number().finite().min(0).max(1).optional(),
  dynamicContrastText: z.boolean().optional(),
  /** Column width in px. Per-column override; falls through to board / global defaults. */
  width: z.number().finite().min(120).max(2000).optional(),
  /** Per-column title font-size override (px). */
  fontSizeTitle: z.number().min(8).max(48).optional(),
  /**
   * Per-column accent colour. Falls through to `board.settings.accentColor`
   * (board-level) and then to the theme default. Drives the accent bar in
   * the column header and tints the per-column card-count badge.
   */
  accent: z.string().optional(),
});

const PartialCardStyleSchema = z.object({
  backgroundColor: z.string().optional(),
  /** Card header (TileHeader band) background colour. Independent of `backgroundColor`,
   *  which fills the outer card shell + the footer/Background zone. */
  headerColor: z.string().optional(),
  /** Card body (text/content area) background colour. */
  bodyColor: z.string().optional(),
  /** Outer card shape — mirrors the tile vocabulary. */
  shape: z.enum(['rectangle', 'rounded']).optional(),
  borderColor: z.string().optional(),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  shadowIntensity: z.number().finite().min(0).max(1).optional(),
  dynamicContrastText: z.boolean().optional(),
  /** Per-card title font-size override (px). */
  fontSizeTitle: z.number().min(8).max(48).optional(),
  /** Per-card body font-size override (px). */
  fontSizeBody: z.number().min(8).max(48).optional(),
});

const PartialTaskStyleSchema = z.object({
  headerColor: z.string().optional(),
  bodyColor: z.string().optional(),
  borderColor: z.string().optional(),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  shadowIntensity: z.number().finite().min(0).max(1).optional(),
  dynamicContrastText: z.boolean().optional(),
  /** Per-task title font-size override (px). */
  fontSizeTitle: z.number().min(8).max(48).optional(),
  /** Per-task body font-size override (px). */
  fontSizeBody: z.number().min(8).max(48).optional(),
});

const PartialTaskSectionStyleSchema = z.object({
  headerColor: z.string().optional(),
  bodyColor: z.string().optional(),
  borderColor: z.string().optional(),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  shadowIntensity: z.number().finite().min(0).max(1).optional(),
  dynamicContrastText: z.boolean().optional(),
  /** Per-section title font-size override (px). */
  fontSizeTitle: z.number().min(8).max(48).optional(),
});

const PartialDocumentStyleSchema = z.object({
  headerColor: z.string().optional(),
  bodyColor: z.string().optional(),
  borderColor: z.string().optional(),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  shadowIntensity: z.number().finite().min(0).max(1).optional(),
  dynamicContrastText: z.boolean().optional(),
});

const MindMapBoardDefaultsSchema = z.object({
  tile: PartialTileStyleSchema.optional(),
  connectionPath: PartialConnectionPathStyleSchema.optional(),
  connectionLabel: PartialConnectionLabelStyleSchema.optional(),
  frame: PartialFrameStyleBlockSchema.optional(),
});

const KanbanBoardDefaultsSchema = z.object({
  column: PartialColumnStyleSchema.optional(),
  card: PartialCardStyleSchema.optional(),
});

const TaskListBoardDefaultsSchema = z.object({
  task: PartialTaskStyleSchema.optional(),
  section: PartialTaskSectionStyleSchema.optional(),
});

const DocumentBoardDefaultsSchema = z.object({
  document: PartialDocumentStyleSchema.optional(),
});

/**
 * Common board settings shared across board types.
 */
const BaseBoardSettingsSchema = z.object({
  backgroundColor: z.string().default(''),
  /**
   * Per-board background-pattern override. Optional — when absent the
   * board inherits from the project-level default for its board type
   * (`settings.mindmap.backgroundPattern` etc.). The CurrentBoardSettings
   * panel writes `undefined` for the "— Inherit —" option.
   */
  backgroundPattern: z.enum(['grid', 'dots', 'lines', 'none']).optional(),
  /**
   * Vault-relative folder (POSIX slashes, no leading/trailing '/') where new
   * text tiles created on this board are written. Empty string ⇒ vault root.
   * Overridden by the vault-wide `activeRootFolder` when one is set. Toggled
   * via the bookmark button in `VaultFileItem`.
   */
  defaultFolder: z.string().default(''),
}).passthrough();

/**
 * Mind Map board-specific settings.
 */
const MindMapSettingsSchema = BaseBoardSettingsSchema.extend({
  semanticZoom: z.boolean().default(true),
  snapToGrid: z.boolean().default(false),
  /**
   * Board-level connection/label visibility override.
   * When false, every connection path/label is hidden regardless of its
   * per-connection `visibility` — but per-connection flags still apply
   * underneath this mask when the board-level flag is true.
   */
  connectionsVisible: z.boolean().default(true),
  labelsVisible: z.boolean().default(true),
  /** Per-board style overrides; unset fields defer to global defaults. */
  defaults: MindMapBoardDefaultsSchema.optional(),
}).passthrough();

/**
 * Saved-view snapshot for the Kanban board. Captures sort + filter state so
 * the user can flip between named views without rebuilding the filter chips
 * each time. Stored on the board's settings rather than `.filo/` so views
 * travel with the board across vault copies.
 */
const KanbanSavedViewSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  sortBy: z.enum(['manual', 'title', 'created', 'dueDate', 'priority']).default('manual'),
  filterTags: z.array(z.string()).default(() => []),
  filterProp: z
    .object({
      // An empty filter key never matches a real frontmatter key, so a
      // hand-edited `key: ''` would silently filter to "all" or "none".
      key: z.string().min(1),
      value: z.string(),
    })
    .nullable()
    .default(null),
}).passthrough();

export type KanbanSavedView = z.infer<typeof KanbanSavedViewSchema>;

/**
 * Kanban board-specific settings.
 */
const KanbanSettingsSchema = BaseBoardSettingsSchema.extend({
  accentColor: z.string().default(ACCENT_COLOR),
  defaults: KanbanBoardDefaultsSchema.optional(),
  /**
   * Named sort/filter combinations the user can flip between. Kept optional
   * (not `default([])`) so existing board-literal call sites that don't yet
   * pass `savedViews` still satisfy the schema's inferred output type.
   */
  savedViews: z
    .array(KanbanSavedViewSchema)
    .refine(...uniqueBy('id', 'kanban savedViews'))
    .optional(),
  /**
   * Last applied transient sort+filter — restored when the board reopens so
   * filter chips don't vanish on tab switch or vault reload. Optional: a
   * fresh board has no lastView; the renderer falls back to manual + no
   * filters. Mirrors the per-board viewport persistence pattern.
   */
  lastView: z
    .object({
      sortBy: z.enum(['manual', 'title', 'created', 'dueDate', 'priority']).default('manual'),
      filterTags: z.array(z.string()).default(() => []),
      filterProp: z
        .object({
          // Mirrors KanbanSavedViewSchema.filterProp.key.
          key: z.string().min(1),
          value: z.string(),
        })
        .nullable()
        .default(null),
    })
    .optional(),
}).passthrough();

/**
 * Saved-view snapshot for the Task List board. Mirrors `KanbanSavedViewSchema`
 * but also captures the active smart-list tab so saved views fully restore the
 * user's perspective on the board.
 */
const TaskListSavedViewSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  groupBy: z.enum(['status', 'priority', 'tag', 'dueDate', 'category', 'none']).default('status'),
  sortBy: z.enum(['title', 'created', 'dueDate', 'priority', 'manual']).default('priority'),
  filterTags: z.array(z.string()).default(() => []),
  filterStatus: z.string().nullable().default(null),
  filterPriority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).nullable().default(null),
  showCompleted: z.boolean().default(true),
  smartList: z
    .enum(['all', 'today', 'upcoming', 'overdue', 'no-date', 'completed'])
    .default('all'),
}).passthrough();

export type TaskListSavedView = z.infer<typeof TaskListSavedViewSchema>;

/**
 * Task List board-specific settings.
 *
 * `groupBy` / `sortBy` drive render-time grouping and ordering. They're
 * defaulted-required so the renderer can consume them without optional
 * chaining.
 */
const TaskListSettingsSchema = BaseBoardSettingsSchema.extend({
  accentColor: z.string().default(ACCENT_COLOR),
  groupBy: z.enum(['status', 'priority', 'tag', 'dueDate', 'category', 'none']).default('status'),
  sortBy: z.enum(['title', 'created', 'dueDate', 'priority', 'manual']).default('priority'),
  /**
   * Board-title font-size override (px). Seeded from
   * `settings.general.defaultBoardFontSize.taskListTitle` at board
   * creation. Absent on legacy boards → CSS fallback.
   */
  titleFontSize: z.number().min(8).max(48).optional(),
  defaults: TaskListBoardDefaultsSchema.optional(),
  savedViews: z
    .array(TaskListSavedViewSchema)
    .refine(...uniqueBy('id', 'tasklist savedViews'))
    .optional(),
  lastView: z
    .object({
      groupBy: z.enum(['status', 'priority', 'tag', 'dueDate', 'category', 'none']).default('status'),
      sortBy: z.enum(['title', 'created', 'dueDate', 'priority', 'manual']).default('priority'),
      filterTags: z.array(z.string()).default(() => []),
      filterStatus: z.string().nullable().default(null),
      filterPriority: z
        .enum(['urgent', 'high', 'medium', 'low', 'none'])
        .nullable()
        .default(null),
      showCompleted: z.boolean().default(true),
      smartList: z
        .enum(['all', 'today', 'upcoming', 'overdue', 'no-date', 'completed'])
        .default('all'),
    })
    .optional(),
  // Per-board geometry for the floating Table of Contents panel. Optional —
  // boards without this field fall back to a sensible default position on
  // first render.
  tocPanelBounds: z
    .object({
      // .finite() guard so a hand-edited bounds payload
      // (NaN, ±Infinity) can't translate into NaN CSS transforms that
      // freeze the floating panel off-screen.
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite(),
      height: z.number().finite(),
    })
    .optional(),
}).passthrough();

/**
 * Document board-specific settings.
 */
const DocumentSettingsSchema = BaseBoardSettingsSchema.extend({
  accentColor: z.string().default(ACCENT_COLOR),
  /** Per-board document-element overrides; unset fields defer to global defaults. */
  defaults: DocumentBoardDefaultsSchema.optional(),
}).passthrough();

/**
 * Tile group — a logical grouping of tiles that move together.
 *
 * `displayIndex` is a monotonically increasing per-board counter assigned
 * when the group is created. It drives the small number badge rendered
 * above every tile that belongs to the group. The counter is monotonic
 * (never reused) so the user-visible "Group 3" remains "3" even after
 * group 1 or 2 are ungrouped. Optional in the schema for backward
 * compatibility with older `.board.json` files — those get backfilled on
 * load by `boardLoader`.
 */
export const TileGroupSchema = z.object({
  id: z.string().min(1),
  // `.min(1)` per element rejects empty strings; the array
  // `.refine` rejects duplicates. A duplicate tileId in a group silently
  // breaks every move-group / ungroup operation that maps over ids.
  tileIds: z.array(z.string().min(1)).refine(...uniqueStrings('TileGroup.tileIds')),
  boardId: z.string(),
  displayIndex: z.number().int().min(1).optional(),
}).passthrough();

export type TileGroup = z.infer<typeof TileGroupSchema>;

// ── Board schemas ──

const BaseBoardSchema = z.object({
  id: z.string().min(1),
  name: z.string().default('Untitled Board'),
  emoji: z.string().default(''),
  // .finite() rejects NaN / ±Infinity from hand-edited files.
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).passthrough();

export const MindMapBoardSchema = BaseBoardSchema.extend({
  type: z.literal('mindmap'),
  settings: MindMapSettingsSchema.prefault({}),
  // Note: per-board pan/zoom now lives in `.filo/viewports.json` keyed by
  // boardId. Older `.board.json` files with an inline `viewport` field are
  // still accepted (the schema is .passthrough()) but the field is ignored
  // and stripped on the next save.
  /**
   * Vault-backed tile placements: maps tileId -> placement (position, size, locked, faded).
   * The tile's content and style are stored separately in the vault's tiles.json.
   *
   * Record keys are validated against the nanoid pattern
   * via `idString`. A hand-edited `.board.json` with an empty or
   * special-character key would otherwise pass through and collide
   * silently with whatever the renderer minted next.
   */
  placements: z.record(idString, TilePlacementSchema).default(() => ({})),
  /**
   * Inline tiles (Link, Embed, Timer) — stored fully in project.json.
   * These tile types are not vault-backed and have no entry in tiles.json.
   */
  inlineTiles: z.record(idString, InlineTileSchema).default(() => ({})),
  // `.min(1)` + uniqueness check on the flat ID arrays.
  // The connections record at the envelope level is the source of truth;
  // this array is the per-mindmap render-order list. A duplicate id here
  // double-renders a connection and confuses every selection / delete op.
  connections: z.array(z.string().min(1)).default(() => []).refine(...uniqueStrings('MindMapBoard.connections')),
  frames: z.array(z.string().min(1)).default(() => []).refine(...uniqueStrings('MindMapBoard.frames')),
  waypoints: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        // .finite() rejects NaN / ±Infinity that a hand-
        // edited .board.json could otherwise propagate into pan-to-
        // waypoint transforms (and crash the renderer's matrix math).
        x: z.number().finite(),
        y: z.number().finite(),
        zoom: z.number().finite().default(1),
        icon: z.string().default('📌'),
        locked: z.boolean().default(false),
      }).passthrough(),
    )
    .default(() => [])
    .refine(...uniqueBy('id', 'waypoints')),
  groups: z.array(TileGroupSchema).default(() => []).refine(...uniqueBy('id', 'groups')),
}).passthrough();

/**
 * Kanban column. Placement-only shape — content lives in `tileDefs`.
 *
 * `wipLimit` is the optional work-in-progress cap for the column. `0` and
 * `undefined` both mean "no limit"; the rendering layer only flags overflow
 * when a positive limit is set. Stored on the column rather than board
 * settings so per-column workflows (Backlog vs. Doing) can carry independent
 * caps.
 */
const KanbanColumnSchema = z.object({
  id: z.string().min(1),
  // An empty title renders the column header as a blank band with no
  // affordance for selection or rename; `addColumn` seeds 'New Column'.
  title: z.string().min(1),
  // Columns render by sorted `position`; a negative value would invert the
  // order. Matches the TaskListSection.position bound.
  position: z.number().int().nonnegative().default(0),
  collapsed: z.boolean().default(false),
  style: PartialColumnStyleSchema.optional(),
  tilePlacements: z.array(KanbanTilePlacementSchema).default(() => []),
  wipLimit: z.number().int().min(0).optional(),
  // Column-level cover image (vault-relative path).
  // Mirrors `KanbanTilePlacement.coverImage` but applies to the column
  // header band rather than an individual card. The cascade-delete and
  // rename pipelines in `lib/vault/fileRefIntegrity.ts` scan this field
  // alongside the placement-level one, so deleting the image file
  // clears the reference rather than leaving a broken thumbnail.
  coverImage: z.string().optional(),
}).passthrough();

export const KanbanBoardSchema = BaseBoardSchema.extend({
  type: z.literal('kanban'),
  settings: KanbanSettingsSchema.prefault({}),
  columns: z.array(KanbanColumnSchema).default(() => []).refine(...uniqueBy('id', 'columns')),
}).passthrough();

/**
 * Persistent user-defined section in a Task List board.
 *
 * `position` is the absolute index in the flat `tasks` array at which this
 * section *starts*; every task between this section's position and the next
 * section's position belongs to it. Empty sections are representable (two
 * consecutive section positions). When `sections.length > 0` the runtime
 * disables the `groupBy` view to avoid double-grouping.
 *
 * Backward-compat: `sections` defaults to `[]`, so every existing
 * .board.json file loads without migration.
 */
const TaskListSectionSchema = z.object({
  id: z.string().min(1),
  // An empty title renders the section divider as a blank
  // band with no rename affordance. Every legitimate creation path
  // (`addSection` in lib/tasklist/sectionOps.ts) seeds 'New Section'.
  title: z.string().min(1),
  position: z.number().int().nonnegative(),
  collapsed: z.boolean().default(false),
  /** Per-section style override; cascades to board.section then global section defaults. */
  style: PartialTaskSectionStyleSchema.optional(),
}).passthrough();

export const TaskListBoardSchema = BaseBoardSchema.extend({
  type: z.literal('tasklist'),
  settings: TaskListSettingsSchema.prefault({}),
  /**
   * Task placements — flat list. Each entry references `tileDefs[tileId]`
   * (always a `text` tile). `position` is honoured only when `sortBy` is
   * `'manual'`; other modes derive ordering from frontmatter at render time.
   */
  tasks: z.array(TaskPlacementSchema).default(() => []).refine(...uniqueBy('tileId', 'tasks')),
  sections: z.array(TaskListSectionSchema).default(() => []).refine(...uniqueBy('id', 'sections')),
  /**
   * Tile IDs whose subtree is collapsed in the renderer. Persisted so a
   * user's "hide subtasks" state survives tab switch / reload, matching
   * the per-section `collapsed` flag. Legacy boards (field absent) hydrate
   * to `[]` via the schema default.
   */
  // `.min(1)` + uniqueness. A duplicate id here would
  // double-toggle the same subtree's collapsed state and corrupt the
  // collapse/expand UX.
  collapsedSubtasks: z.array(z.string().min(1)).default(() => []).refine(...uniqueStrings('TaskListBoard.collapsedSubtasks')),
}).passthrough();

export const DocumentBoardSchema = BaseBoardSchema.extend({
  type: z.literal('document'),
  settings: DocumentSettingsSchema.prefault({}),
  // Vault-relative path of the note this board shows. The body lives there.
  filePath: z.string(),
}).passthrough();

/**
 * Discriminated union of all board types.
 *
 * DECISION: every nested schema uses `.passthrough()`. This intentionally
 * preserves any unknown fields a future Filo version (or a third-party tool)
 * may have written into a board file — round-tripping the file shouldn't
 * destroy data Filo doesn't currently understand. The trade-off is that
 * orphaned fields accumulate over time; this is acceptable because (a) board
 * files are small and (b) the user owns the format and can hand-edit JSON.
 */
export const BoardSchema = z.discriminatedUnion('type', [
  MindMapBoardSchema,
  KanbanBoardSchema,
  TaskListBoardSchema,
  DocumentBoardSchema,
]).superRefine((board, ctx) => {
  // Kanban tileId uniqueness across columns. Applied at
  // the union level so the underlying KanbanBoardSchema remains a
  // ZodObject suitable for z.discriminatedUnion (refine-on-the-object
  // would return ZodEffects, which discriminatedUnion can't accept).
  if (board.type === 'kanban') {
    const seen = new Set<string>();
    for (const col of (board.columns ?? [])) {
      for (const placement of (col.tilePlacements ?? [])) {
        if (seen.has(placement.tileId)) {
          ctx.addIssue({
            code: 'custom',
            message: `Kanban tileId duplicated across columns: ${placement.tileId}`,
            path: ['columns'],
          });
          return;
        }
        seen.add(placement.tileId);
      }
    }
  }
  // placements + inlineTiles must have disjoint key sets.
  // Same union-level placement as above.
  if (board.type === 'mindmap') {
    const placementIds = Object.keys((board as { placements?: Record<string, unknown> }).placements ?? {});
    const inlineIds = new Set(Object.keys((board as { inlineTiles?: Record<string, unknown> }).inlineTiles ?? {}));
    for (const id of placementIds) {
      if (inlineIds.has(id)) {
        ctx.addIssue({
          code: 'custom',
          message: `tileId appears in both placements and inlineTiles: ${id}`,
          path: ['inlineTiles'],
        });
        return;
      }
    }
  }
});

export type Board = z.infer<typeof BoardSchema>;
export type MindMapBoard = z.infer<typeof MindMapBoardSchema>;
export type KanbanBoard = z.infer<typeof KanbanBoardSchema>;
export type TaskListBoard = z.infer<typeof TaskListBoardSchema>;
export type TaskListSection = z.infer<typeof TaskListSectionSchema>;
export type DocumentBoard = z.infer<typeof DocumentBoardSchema>;
