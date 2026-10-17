import { z } from 'zod';
import { BorderStyleSchema, ShapeSchema } from './styleEnums';
import { coerceToNumber, optionalNumber } from './schemaUtils';

/** A timer tile's display mode: the one list (tile, placement, the mode button's cycle). */
export const TimerModeSchema = z.enum(['hms', 'ms', 's', 'clock']);
export type TimerMode = z.infer<typeof TimerModeSchema>;

/**
 * Two layers live here:
 *
 * - The runtime `Tile*Schema` types describe a tile as the views see it. A
 *   text tile's `title` and `tags` are projected from its note (frontmatter
 *   `title:` / `tags:`) when the board's tiles are derived; they are never
 *   stored on the board. These keep `.passthrough()` so a construction site
 *   may carry view-only extras.
 * - The `*TileDefSchema` variants describe what a `.board.json` stores (v8).
 *   They are strict about what survives: see the note above
 *   `TileDefinitionBase`.
 */

/**
 * Position and size shared by all tiles on the canvas.
 *
 * `.finite()` rejects NaN and ±Infinity. A tile parked at non-finite coords
 * corrupts the rbush spatial index and renders as an unselectable invisible
 * hitbox — catch it at parse time so the board lands in `failedBoards` +
 * recovery snapshot rather than poisoning the live canvas.
 */
const PositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).passthrough();

const SizeSchema = z.object({
  width: coerceToNumber(240).pipe(z.number().finite().min(80)),
  height: coerceToNumber(160).pipe(z.number().finite().min(60)),
}).passthrough();

/**
 * Style properties shared by all tiles.
 *
 * Required fields: only `headerColor` and `bodyColor`, because every tile
 * needs *something* to render with (the empty string sentinel ⇒ cascade
 * to board/global). All other fields are optional so the resolver in
 * `effectiveStyle.ts` can fall through the per-element layer when the
 * user clicks "Restore to Theme Defaults" — a defaulted shape/borderStyle
 * field would otherwise bake the schema default into the per-element
 * layer and block any future board/global override.
 */
export const TileStyleSchema = z.object({
  headerColor: z.string(),
  bodyColor: z.string(),
  borderColor: z.string().default(''),
  shape: ShapeSchema.optional(),
  borderStyle: BorderStyleSchema.optional(),
  borderWidth: optionalNumber(z.number().min(0).max(10).optional()),
  shadowIntensity: optionalNumber(z.number().min(0).max(1).optional()),
  // Per-element override of the Dynamic Contrast Text feature. `null` means
  // "inherit from board settings"; `true`/`false` overrides at this layer.
  dynamicContrastText: z.boolean().nullable().optional(),
  // Per-element font-size overrides (px). Absent → the tile cascade (board,
  // Global Defaults, then General → Default Board Font Size).
  fontSizeTitle: z.number().min(8).max(48).optional(),
  fontSizeBody: z.number().min(8).max(48).optional(),
}).passthrough();

/**
 * Common fields shared by every tile type.
 */
const BaseTileSchema = z.object({
  id: z.string().min(1),
  title: z.string().default('New Tile'),
  // Optional rich-text HTML of the title carrying inline marks (colour,
  // highlight, bold, italic, etc.) applied via the GlobalToolbar while the
  // title was being edited in TipTap. `title` stays the canonical plain
  // text used for filenames and aria-labels; `titleHtml` is the rendered
  // form.
  titleHtml: z.string().optional(),
  position: PositionSchema,
  size: SizeSchema,
  style: TileStyleSchema,
  locked: z.boolean().default(false),
  faded: z.boolean().default(false),
  // Media-only display toggle. The persisted default lives on
  // TilePlacementSchema.frameless; this runtime mirror is `.optional()` — like
  // titleHtml / renderedWidth — so the many `as Tile` construction sites need
  // not all set it. Readers treat absent as false (`tile.frameless === true`).
  // Only meaningful for media tile types (image / video / audio / file).
  frameless: z.boolean().optional(),
  tags: z.array(z.string()).default(() => []), // tag names (canonical identifier)
  boardId: z.string().min(1),
  /** Cached DOM-measured rendered width (for auto-height tiles). */
  renderedWidth: z.number().finite().optional(),
  /** Cached DOM-measured rendered height (for auto-height tiles). */
  renderedHeight: z.number().finite().optional(),
  // .finite() rejects NaN / ±Infinity from hand-edited files.
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).passthrough();

// ── Individual tile type schemas ──

const TextTileSchema = BaseTileSchema.extend({
  type: z.literal('text'),
  content: z.string().default(''), // editor HTML, view-only
  /**
   * Vault-relative path of the backing .md file: the note's identity. Absent
   * only on a tile that hasn't been placed yet (`stampTextTileSeedPath`
   * picks its path before the def is built).
   */
  filePath: z.string().optional(),
}).passthrough();

export const ImageTileSchema = BaseTileSchema.extend({
  type: z.literal('image'),
  src: z.string().default(''), // URL or relative vault path
  /**
   * Accessible alt text. Falls back to the tile title when empty so a freshly
   * dropped image still announces something useful to screen readers.
   */
  alt: z.string().optional(),
}).passthrough();

const VideoTileSchema = BaseTileSchema.extend({
  type: z.literal('video'),
  src: z.string().default(''),
  isPlaying: z.boolean().default(false),
}).passthrough();

const FileTileSchema = BaseTileSchema.extend({
  type: z.literal('file'),
  filePath: z.string().default(''), // relative vault path
  fileName: z.string().default(''),
  fileExtension: z.string().default(''),
}).passthrough();

const AudioTileSchema = BaseTileSchema.extend({
  type: z.literal('audio'),
  src: z.string().default(''), // relative vault path to MP3
  isPlaying: z.boolean().default(false),
}).passthrough();

/**
 * URL scheme guard for tiles that emit `src=`/`href=`
 * attributes into the renderer. Empty, http(s), and `about:blank` pass;
 * anything else (`javascript:`, `data:`, `file:`, custom protocols) is
 * rejected at parse time so a hand-edited or future-migrated tile def
 * with a hostile URL can't reach the DOM through the schema-validated
 * path. Real-world tile data is typed manually or pulled from
 * `link:fetch-metadata`, which only resolves https URLs, so the
 * legitimate value range is narrow.
 */
const TILE_URL_REGEX = /^(https?:|about:blank$)/;
export const tileUrlString = z
  .string()
  .refine(
    (url) => url === '' || TILE_URL_REGEX.test(url),
    { message: 'expected empty, http(s):, or about:blank URL' },
  );

export const LinkTileSchema = BaseTileSchema.extend({
  type: z.literal('link'),
  url: tileUrlString.default(''),
}).passthrough();

export const IframeTileSchema = BaseTileSchema.extend({
  type: z.literal('iframe'),
  url: tileUrlString.default(''),
}).passthrough();

export const TimerTileSchema = BaseTileSchema.extend({
  type: z.literal('timer'),
  // `.nonnegative()` because a negative duration / remaining
  // is nonsensical: the renderer renders the count-down monotonically
  // toward zero and stops there, so negative seeds either no-op or wrap
  // around when a tick subtracts. A hand-edited `.board.json` with a
  // negative timer field belongs in failedBoards, not on the canvas.
  duration: z.number().finite().nonnegative().default(0), // milliseconds
  remaining: z.number().finite().nonnegative().default(0), // milliseconds
  mode: TimerModeSchema.default('hms'),
  isRunning: z.boolean().default(false),
  // Wall-clock end (epoch ms) of a running countdown; absent while stopped.
  endsAt: z.number().finite().nonnegative().optional(),
}).passthrough();

/**
 * Canonical list of tile type discriminators. Kept in one place so the
 * runtime `TileSchema` union and the on-disk `TileDefinitionSchema`
 * discriminator literals cannot drift — if a tile type is added or
 * removed, both gates update together. Used by `boardLoader` to drop
 * unknown-type tile defs.
 */
export const TILE_TYPES = [
  'text',
  'image',
  'video',
  'file',
  'audio',
  'link',
  'iframe',
  'timer',
] as const;

export type TileType = typeof TILE_TYPES[number];

/**
 * Discriminated union of all tile types.
 */
export const TileSchema = z.discriminatedUnion('type', [
  TextTileSchema,
  ImageTileSchema,
  VideoTileSchema,
  FileTileSchema,
  AudioTileSchema,
  LinkTileSchema,
  IframeTileSchema,
  TimerTileSchema,
]);

export type TileStyle = z.infer<typeof TileStyleSchema>;
export type Tile = z.infer<typeof TileSchema>;
export type TextTile = z.infer<typeof TextTileSchema>;
export type ImageTile = z.infer<typeof ImageTileSchema>;
export type VideoTile = z.infer<typeof VideoTileSchema>;
export type FileTile = z.infer<typeof FileTileSchema>;
export type AudioTile = z.infer<typeof AudioTileSchema>;
export type LinkTile = z.infer<typeof LinkTileSchema>;
export type IframeTile = z.infer<typeof IframeTileSchema>;
export type TimerTile = z.infer<typeof TimerTileSchema>;

/**
 * Tile definition stored in the vault's `.board.json` (board format v8).
 *
 * A board file holds only what is visual. A note-backed or file-backed def
 * names its file by vault path and nothing else: the note's title, tags and
 * body live in the `.md` (frontmatter `title:` / `tags:`), and a media file's
 * tags live in `.filo/tags.json:fileTags[path]`. Keeping a second copy here is
 * exactly what let two copies disagree and the wrong one win.
 *
 * Placement-specific fields (position, size, boardId, locked, faded) live on
 * the board's placements, not here. Inline tiles (link, iframe, timer) have no
 * file, so they keep their own `title` / `tags` and are stored as
 * `InlineTile` on Mind Map boards.
 *
 * No `.passthrough()` on any variant: an unknown or removed key (an older
 * Filo's `title` / `tags` / `content` / note id, a leaked task field) is
 * dropped on parse, so it can never survive a load and save.
 */
const TileDefinitionBase = z.object({
  id: z.string().min(1),
  // Formatted title (inline marks) is visual, so the board owns it. It is
  // shown only while its plain text still equals the note's title.
  titleHtml: z.string().optional(),
  style: TileStyleSchema,
  // .finite() rejects NaN / ±Infinity from hand-edited files.
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

/** Base for tiles backed by a media file: the def carries a caption title. */
const MediaTileDefinitionBase = TileDefinitionBase.extend({
  title: z.string().default(''),
});

/** Base for board-only tiles, which own their title and tags. */
const InlineTileDefinitionBase = TileDefinitionBase.extend({
  title: z.string().default(''),
  tags: z.array(z.string()).default(() => []),
});

/**
 * Text-tile def: a note on a board. `filePath` is the note's vault-relative
 * path and its only identity on disk.
 */
export const TextTileDefSchema = TileDefinitionBase.extend({
  type: z.literal('text'),
  filePath: z.string().min(1),
});

/**
 * Image-tile def. `src` is required so a hand-edited `{ type: 'image' }`
 * with no source path fails parse instead of being silently rendered as a
 * broken image.
 */
export const ImageTileDefSchema = MediaTileDefinitionBase.extend({
  type: z.literal('image'),
  src: z.string(),
  alt: z.string().optional(),
});

export const VideoTileDefSchema = MediaTileDefinitionBase.extend({
  type: z.literal('video'),
  src: z.string(),
  isPlaying: z.boolean().default(false),
});

// No `isRecording`: a take is runtime state. A board file that still carries
// one loads without it, so its tile is never stuck on "Recording…".
export const AudioTileDefSchema = MediaTileDefinitionBase.extend({
  type: z.literal('audio'),
  src: z.string(),
  isPlaying: z.boolean().default(false),
});

/** Generic-file def. The display name and extension derive from `filePath`. */
export const FileTileDefSchema = MediaTileDefinitionBase.extend({
  type: z.literal('file'),
  filePath: z.string(),
});

/**
 * Link / Iframe def. `url` flows through `tileUrlString` (empty / http(s) /
 * about:blank) so a `javascript:` URL is refused at parse time, not at
 * render time.
 */
export const LinkTileDefSchema = InlineTileDefinitionBase.extend({
  type: z.literal('link'),
  url: tileUrlString.default(''),
});

export const IframeTileDefSchema = InlineTileDefinitionBase.extend({
  type: z.literal('iframe'),
  url: tileUrlString.default(''),
});

export const TimerTileDefSchema = InlineTileDefinitionBase.extend({
  type: z.literal('timer'),
  // Mirrors TimerTileSchema.duration / remaining.
  duration: z.number().finite().nonnegative().default(0),
  remaining: z.number().finite().nonnegative().default(0),
  mode: TimerModeSchema.default('hms'),
  isRunning: z.boolean().default(false),
  endsAt: z.number().finite().nonnegative().optional(),
});

/**
 * Discriminated union of every tile-def variant. Mirrors `TileSchema` so a
 * tile type added to one must be added to the other — `TILE_TYPES`
 * (above) is the single literal source of truth for the discriminator
 * values that gate both.
 *
 * Unknown discriminator values are filtered out upstream in
 * `boardLoader.preFilterUnknownTileTypes` before this parse runs — once
 * they reach this schema the parse is meant to fail loud.
 */
export const TileDefinitionSchema = z.discriminatedUnion('type', [
  TextTileDefSchema,
  ImageTileDefSchema,
  VideoTileDefSchema,
  AudioTileDefSchema,
  FileTileDefSchema,
  LinkTileDefSchema,
  IframeTileDefSchema,
  TimerTileDefSchema,
]);

export type TileDefinition = z.infer<typeof TileDefinitionSchema>;
export type TextTileDef = z.infer<typeof TextTileDefSchema>;
