import { z } from 'zod';
import { coerceToNumber, optionalNumber } from './schemaUtils';

/**
 * ── `.passthrough()` contract ────────────────────────────────────────────
 *
 * Every tile-side schema in this file (`TileStyleSchema`, `BaseTileSchema`,
 * each per-type runtime `Tile*Schema`, and each per-type
 * `*TileDefSchema`) ends in `.passthrough()`. Unknown keys parsed from
 * `.board.json` survive the load + cache + save round-trip — so opening a
 * board written by a future Filo build and re-saving it preserves any new
 * tile fields that build added. The round-trip is carried by
 * `JSON.parse(JSON.stringify(...))` in `boardSaver.writeBoardFile`.
 *
 * The one explicit `.preprocess` in this file (`TileDefinitionSchema`)
 * strips the `TASK_METADATA_FIELDS` set BEFORE the discriminated union
 * sees them — that data is canonical in the backing `.md` frontmatter,
 * not the board JSON, and a leaked copy here would silently desync from
 * the source of truth on every reload (CLAUDE.md "Source of Truth
 * Hierarchy").
 *
 * Trade-off: passthrough fields are typed `unknown` and invisible to the
 * schema-typed `Tile` view (lines 196 ff.). Readers that need to inspect a
 * forward-compat field widen the type at the call site. Prefer declaring
 * new fields on the schema over relying on passthrough.
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
  shape: z.enum(['rectangle', 'rounded']).optional(),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  borderWidth: optionalNumber(z.number().min(0).max(10).optional()),
  shadowIntensity: optionalNumber(z.number().min(0).max(1).optional()),
  // Per-element override of the Dynamic Contrast Text feature. `null` means
  // "inherit from board settings"; `true`/`false` overrides at this layer.
  dynamicContrastText: z.boolean().nullable().optional(),
  // Per-element font-size overrides (px). Seeded from
  // `settings.general.defaultBoardFontSize` at creation; absent for
  // legacy tiles, which fall through to CSS fallbacks.
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

export const TextTileSchema = BaseTileSchema.extend({
  type: z.literal('text'),
  contentId: z.string(), // shared content ID (links to Document board)
  content: z.string().default(''), // HTML/markdown content
  /**
   * Vault-relative path of the backing .md file when it diverges from the
   * `${title}.md` convention (e.g. after the user moves the file into a
   * subfolder). When absent, callers fall back to the convention path.
   * Recognised by `fileRefIntegrity` and rewritten on every vault rename.
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

export const VideoTileSchema = BaseTileSchema.extend({
  type: z.literal('video'),
  src: z.string().default(''),
  isPlaying: z.boolean().default(false),
}).passthrough();

export const FileTileSchema = BaseTileSchema.extend({
  type: z.literal('file'),
  filePath: z.string().default(''), // relative vault path
  fileName: z.string().default(''),
  fileExtension: z.string().default(''),
}).passthrough();

export const AudioTileSchema = BaseTileSchema.extend({
  type: z.literal('audio'),
  src: z.string().default(''), // relative vault path to MP3
  isRecording: z.boolean().default(false),
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
  duration: z.number().finite().nonnegative().default(0), // seconds
  remaining: z.number().finite().nonnegative().default(0),
  mode: z.enum(['hms', 'ms', 's', 'clock']).default('hms'),
  isRunning: z.boolean().default(false),
}).passthrough();

/**
 * Canonical list of tile type discriminators. Kept in one place so the
 * runtime `TileSchema` union and the on-disk `TileDefinitionSchema`
 * discriminator literals cannot drift — if a tile type is added or
 * removed, both gates update together. Used by `boardLoader` to drop
 * unknown-type tile defs left over from removed board types (e.g. the
 * calendar removal had no migration).
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
 * Tile definition stored in the vault's `.board.json`.
 * Contains all intrinsic tile data (content, style, identity) but excludes
 * placement-specific fields: position, size, boardId, locked, faded,
 * renderedWidth, renderedHeight.
 *
 * Vault-backed tile types: text, image, video, audio, file.
 * Non-vault types (link, iframe, timer) are stored as InlineTile in `.board.json`.
 *
 * Modelled as a discriminated union mirroring `TileSchema` so
 * type-specific fields are validated at parse time. A hand-edited
 * `.board.json` with `{ type: 'link', url: 'javascript:alert(1)' }` is
 * rejected by `tileUrlString` at the def layer rather than relying on the
 * runtime tile schema (which only runs when the placement is converted to a
 * runtime tile). Each variant keeps `.passthrough()` so a forward-compat
 * field survives load → cache → save round-trip.
 */

/**
 * Task / Kanban-card metadata that belongs in YAML frontmatter of the backing
 * `.md` file — never in board JSON tile defs. The schema strips these fields
 * on parse so a future regression in `buildTileDefinition` (or a legacy
 * board.json that accidentally carries them) cannot leak the wrong source of
 * truth into the cache. A `console.warn` flags every strip so the leak is
 * observable rather than silent. CLAUDE.md "Source of Truth Hierarchy"
 * codifies this: frontmatter wins on conflict.
 */
export const TASK_METADATA_FIELDS = [
  'completed',
  'priority',
  'dueDate',
  'dueTime',
  'startDate',
  'status',
  'parent',
  'recurrence',
  'recurrenceMode',
] as const;

/**
 * Common identity / style / timestamp fields shared by every tile-def
 * variant. Kept as a plain `z.object` (no `.passthrough()` here) because the
 * discriminated-union members extend it and add their own passthrough — Zod
 * applies the last passthrough call, so applying it on the base would be
 * silently overridden by the per-variant `.extend()`.
 */
const TileDefinitionBase = z.object({
  id: z.string().min(1),
  title: z.string().default('New Tile'),
  titleHtml: z.string().optional(),
  style: TileStyleSchema,
  tags: z.array(z.string()).default(() => []),
  // .finite() rejects NaN / ±Infinity from hand-edited files.
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});

/**
 * Text-tile def. `contentId` is required (no default) because every text
 * tile must point at a shared document id — `buildTileDefinition` always
 * emits one, and a missing value would silently desync the cache from the
 * `.md` file. `content` carries no canonical data (the body lives in the
 * `.md`) and defaults to '' for the rare hand-built test fixture.
 */
export const TextTileDefSchema = TileDefinitionBase.extend({
  type: z.literal('text'),
  contentId: z.string(),
  content: z.string().default(''),
  filePath: z.string().optional(),
}).passthrough();

/**
 * Image-tile def. `src` is required so a hand-edited `{ type: 'image' }`
 * with no source path fails parse instead of being silently rendered as a
 * broken image. Runtime tiles tolerate empty src for "just created, no file
 * yet" cases; on-disk defs are produced by `buildTileDefinition`, which
 * always emits a string.
 */
export const ImageTileDefSchema = TileDefinitionBase.extend({
  type: z.literal('image'),
  src: z.string(),
  alt: z.string().optional(),
}).passthrough();

export const VideoTileDefSchema = TileDefinitionBase.extend({
  type: z.literal('video'),
  src: z.string(),
  isPlaying: z.boolean().default(false),
}).passthrough();

export const AudioTileDefSchema = TileDefinitionBase.extend({
  type: z.literal('audio'),
  src: z.string(),
  isRecording: z.boolean().default(false),
  isPlaying: z.boolean().default(false),
}).passthrough();

export const FileTileDefSchema = TileDefinitionBase.extend({
  type: z.literal('file'),
  filePath: z.string(),
  fileName: z.string().default(''),
  fileExtension: z.string().default(''),
}).passthrough();

/**
 * Link / Iframe def. `url` flows through `tileUrlString` (empty / http(s) /
 * about:blank) so the `javascript:`-URL hole that `.passthrough()` left
 * open is closed at parse time, not at render time.
 */
export const LinkTileDefSchema = TileDefinitionBase.extend({
  type: z.literal('link'),
  url: tileUrlString.default(''),
}).passthrough();

export const IframeTileDefSchema = TileDefinitionBase.extend({
  type: z.literal('iframe'),
  url: tileUrlString.default(''),
}).passthrough();

export const TimerTileDefSchema = TileDefinitionBase.extend({
  type: z.literal('timer'),
  // Mirrors TimerTileSchema.duration / remaining.
  duration: z.number().finite().nonnegative().default(0),
  remaining: z.number().finite().nonnegative().default(0),
  mode: z.enum(['hms', 'ms', 's', 'clock']).default('hms'),
  isRunning: z.boolean().default(false),
}).passthrough();

/**
 * Discriminated union of every tile-def variant. Mirrors `TileSchema` so a
 * tile type added to one must be added to the other — `TILE_TYPES`
 * (above) is the single literal source of truth for the discriminator
 * values that gate both.
 *
 * Unknown discriminator values (e.g. legacy `calendar` defs left over from
 * the removed board type) are filtered out upstream in
 * `boardLoader.preFilterUnknownTileTypes` before this parse runs — once
 * they reach this schema the parse is meant to fail loud.
 */
const TileDefinitionVariants = z.discriminatedUnion('type', [
  TextTileDefSchema,
  ImageTileDefSchema,
  VideoTileDefSchema,
  AudioTileDefSchema,
  FileTileDefSchema,
  LinkTileDefSchema,
  IframeTileDefSchema,
  TimerTileDefSchema,
]);

export const TileDefinitionSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;
  let leaked: string[] | null = null;
  for (const field of TASK_METADATA_FIELDS) {
    if (field in obj) {
      (leaked ??= []).push(field);
    }
  }
  if (!leaked) return obj;
  const cleaned: Record<string, unknown> = {};
  const blocked = TASK_METADATA_FIELDS as readonly string[];
  for (const [k, v] of Object.entries(obj)) {
    if (!blocked.includes(k)) cleaned[k] = v;
  }
  console.warn(
    `[TileDefinitionSchema] Stripped task-metadata fields from tile def "${String(obj.id ?? '?')}":`,
    leaked,
  );
  return cleaned;
}, TileDefinitionVariants);

export type TileDefinition = z.infer<typeof TileDefinitionSchema>;
export type TextTileDef = z.infer<typeof TextTileDefSchema>;
export type ImageTileDef = z.infer<typeof ImageTileDefSchema>;
export type VideoTileDef = z.infer<typeof VideoTileDefSchema>;
export type AudioTileDef = z.infer<typeof AudioTileDefSchema>;
export type FileTileDef = z.infer<typeof FileTileDefSchema>;
export type LinkTileDef = z.infer<typeof LinkTileDefSchema>;
export type IframeTileDef = z.infer<typeof IframeTileDefSchema>;
export type TimerTileDef = z.infer<typeof TimerTileDefSchema>;
