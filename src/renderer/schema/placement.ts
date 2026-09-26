import { z } from 'zod';
import { BorderStyleSchema, ShapeSchema } from './styleEnums';
import { coerceToNumber } from './schemaUtils';
import { TileStyleSchema, tileUrlString } from './tile';

/**
 * Placement of a vault-backed tile on a board canvas.
 * Stored per-board in project.json (board.placements[tileId]).
 * The tile's content and style live separately in the vault's tiles.json.
 *
 * `.finite()` rejects NaN / ±Infinity — see PositionSchema in tile.ts.
 */
export const TilePlacementSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: coerceToNumber(240).pipe(z.number().finite().min(80)),
  height: coerceToNumber(160).pipe(z.number().finite().min(60)),
  locked: z.boolean().default(false),
  faded: z.boolean().default(false),
  // Per-placement "media-only" display toggle. When true, the tile renders
  // without its header bar, border, shadow, and body background so only the
  // media is visible (header re-reveals on hover). Mirrors `faded`: a
  // per-board display choice that does NOT travel with the shared tile def.
  // Only meaningful for media tile types (image / video / audio / file).
  frameless: z.boolean().default(false),
}).passthrough();


// ── Placement-based shapes for Kanban / Task List ──
//
// Every non-mindmap board now references content via `tileId → tileDefs[tileId]`,
// just like Mind Map. Per-element style overrides cascade through the existing
// override resolver; missing fields fall through to per-board / global defaults.

/**
 * Per-card style override on a Kanban placement.
 * Mirrors the shape used by `effectiveStyle.resolveCardStyle`.
 */
const PartialKanbanCardStyleSchema = z.object({
  /** Outer card shell background. Fills the footer/"Background" zone below the
   *  body. `headerColor` and `bodyColor` overlay on top of this for the
   *  TileHeader and body content respectively. */
  backgroundColor: z.string().optional(),
  /** Card header (TileHeader band) background colour. */
  headerColor: z.string().optional(),
  /** Card body (text/content area) background colour. */
  bodyColor: z.string().optional(),
  /** Outer card shape — mirrors the tile vocabulary. */
  shape: ShapeSchema.optional(),
  borderColor: z.string().optional(),
  borderStyle: BorderStyleSchema.optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  shadowIntensity: z.number().finite().min(0).max(1).optional(),
  dynamicContrastText: z.boolean().optional(),
  /** Per-card title font-size override (px). */
  fontSizeTitle: z.number().min(8).max(48).optional(),
  /** Per-card body font-size override (px). */
  fontSizeBody: z.number().min(8).max(48).optional(),
});

export type PartialKanbanCardStyle = z.infer<typeof PartialKanbanCardStyleSchema>;

/**
 * Per-task style override on a Task List placement.
 */
export const PartialTaskStyleSchema = z.object({
  headerColor: z.string().optional(),
  bodyColor: z.string().optional(),
  borderColor: z.string().optional(),
  borderStyle: BorderStyleSchema.optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  shadowIntensity: z.number().finite().min(0).max(1).optional(),
  dynamicContrastText: z.boolean().optional(),
  /** Per-task title font-size override (px). */
  fontSizeTitle: z.number().min(8).max(48).optional(),
  /** Per-task body font-size override (px). */
  fontSizeBody: z.number().min(8).max(48).optional(),
});

export type PartialTaskStyle = z.infer<typeof PartialTaskStyleSchema>;

/**
 * A tile placement inside a Kanban column. Content/style/identity live in
 * `tileDefs[tileId]`; only column-position, placement-style override, and the
 * optional cover image are stored here.
 *
 * `coverImage` is a placement-level field (not frontmatter) because a cover is
 * a board-visual concern attached to the *card*, not document metadata that
 * should travel with the underlying `.md`. Storing it on the placement keeps
 * the same file appearing on multiple boards independently styled.
 */
export const KanbanTilePlacementSchema = z.object({
  tileId: z.string().min(1),
  // `.nonnegative()` mirrors KanbanColumn.position. A hand-
  // edited card with `position: -1` would sort before every valid index and
  // corrupt every subsequent reorder operation that relies on dense
  // monotonic positions.
  position: z.number().int().nonnegative().default(0),
  style: PartialKanbanCardStyleSchema.optional(),
  coverImage: z.string().optional(),
}).passthrough();

export type KanbanTilePlacement = z.infer<typeof KanbanTilePlacementSchema>;

/**
 * A task placement inside a Task List board. The `position` is honoured only
 * when `board.settings.sortBy === 'manual'`; other sort modes derive ordering
 * from the backing `.md` frontmatter at render time.
 */
export const TaskPlacementSchema = z.object({
  tileId: z.string().min(1),
  // `.nonnegative()` mirrors TaskListSection.position. See
  // the KanbanTilePlacement comment for rationale.
  position: z.number().int().nonnegative().default(0),
  style: PartialTaskStyleSchema.optional(),
  // Placement-level lock. Mirrors MindMapTilePlacement.locked semantics:
  // the same task can be locked on this board without affecting other
  // boards that reference the same `.md` file.
  locked: z.boolean().optional(),
}).passthrough();

export type TaskPlacement = z.infer<typeof TaskPlacementSchema>;

/**
 * Inline tile — a tile type excluded from the vault (Link, Embed, Timer).
 * Stores the full tile definition + canvas placement directly in project.json
 * under board.inlineTiles[id]. These tiles do not exist in tiles.json.
 *
 * Every type-specific field is modelled explicitly so a
 * hand-edited `.board.json` can't smuggle a `javascript:` URL through
 * `.passthrough()` and reach the renderer DOM. `tileUrlString` (shared with
 * `LinkTileSchema` / `IframeTileSchema`) refuses anything but empty,
 * `http(s):`, or `about:blank`. Numeric timer fields use `.finite()` to
 * reject NaN / ±Infinity.
 */
export const InlineTileSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['link', 'iframe', 'timer']),
  title: z.string().default(''),
  /**
   * Optional rich-text HTML mirror of the title (inline marks applied via
   * the GlobalToolbar). Same shape as `BaseTileSchema.titleHtml`.
   */
  titleHtml: z.string().optional(),
  style: TileStyleSchema.optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  width: coerceToNumber(240).pipe(z.number().finite().min(80)),
  height: coerceToNumber(160).pipe(z.number().finite().min(60)),
  locked: z.boolean().default(false),
  faded: z.boolean().default(false),
  tags: z.array(z.string()).default(() => []),
  // .finite() rejects NaN / ±Infinity from hand-edited files.
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  // ── Type-specific fields ────────────────────────────────────────────
  // Validated centrally via tileUrlString — empty / http(s) / about:blank
  // only. Used by `link` and `iframe` types; `timer` ignores it.
  url: tileUrlString.optional(),
  // `.nonnegative()` mirrors TimerTileSchema.duration /
  // remaining. Inline timer tiles share the same semantics: negative
  // seeds are nonsense.
  duration: z.number().finite().nonnegative().optional(),
  remaining: z.number().finite().nonnegative().optional(),
  mode: z.enum(['hms', 'ms', 's', 'clock']).optional(),
  isRunning: z.boolean().optional(),
});

export type InlineTile = z.infer<typeof InlineTileSchema>;
