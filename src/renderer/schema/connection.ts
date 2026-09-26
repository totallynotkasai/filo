import { z } from 'zod';
import { ArrowTypeSchema, BorderStyleSchema, PathTypeSchema } from './styleEnums';
import { optionalNumber } from './schemaUtils';

/**
 * ── `.passthrough()` contract ────────────────────────────────────────────
 *
 * Every object schema in this file ends in `.passthrough()`. This means
 * unknown keys parsed from `.board.json` files survive the validation step
 * and are carried through to the cache, then back to disk via
 * `JSON.parse(JSON.stringify(...))` in `boardSaver.writeBoardFile`. As a
 * result a future Filo build that adds a new field on the Connection
 * record will see its data preserved when the file is opened (and re-saved)
 * by an older build that doesn't know about that field.
 *
 * Trade-off: passthrough fields are typed `unknown` and invisible to
 * schema-typed readers. Callers that need to read a forward-compat field
 * have to widen the type at the call site (`(c as Record<string, unknown>)
 * .newField`). The current connection vocabulary has one historical example
 * — the legacy `color` label field that has been superseded by
 * `textColor`/`backgroundColor`. New fields should prefer to be declared
 * on the schema rather than relying on passthrough.
 */

/**
 * Bubble position index (0-7) around a tile:
 * 0=top-left, 1=top-center, 2=top-right,
 * 3=middle-right, 4=bottom-right, 5=bottom-center,
 * 6=bottom-left, 7=middle-left
 */
const BubbleIndex = z.number().int().min(0).max(7);

/**
 * Connection label — text that rides along a connection path.
 *
 * `textColor` + `backgroundColor` are the cascade-resolvable label
 * styles (V5 design doc spec: "Label Styling (font size, text colour,
 * background colour)"). Inline TipTap marks from the toolbar override
 * at the character level. Any legacy `color` field on disk round-trips
 * harmlessly via `.passthrough()` but is no longer read.
 */
export const ConnectionLabelSchema = z.object({
  text: z.string().default(''),
  content: z.string().optional(), // HTML rich text; plain `text` used as fallback for old data
  textColor: z.string().default(''),
  backgroundColor: z.string().default(''),
  // Bound the label font size to the same 8–32 range as the
  // tile/document body cascade so a malformed `.board.json` (or a future UI
  // regression) can't paint a 0-px or 4000-px label that overflows the
  // canvas and DoS's the renderer.
  fontSize: optionalNumber(z.number().min(8).max(32).optional()),
  position: z.number().min(0).max(1).default(0.5), // parametric position on path (0..1)
  locked: z.boolean().default(false),
}).passthrough();

/**
 * Connection between two tiles.
 *
 * pathType / pathSize / pathStyle / arrowType / arrowSize are optional so
 * the resolver in `effectiveStyle.ts` can fall through to the board /
 * global defaults when the user clicks "Restore to Theme Defaults".
 * A `.default()` here would lock the per-connection override on and
 * block any later board/global override. Consumers fall back to
 * 'curved' / 2 / 'solid' / 'none' / 10 when no cascade layer resolves.
 */
export const ConnectionSchema = z.object({
  id: z.string().min(1),
  boardId: z.string().min(1),
  fromTileId: z.string().min(1),
  toTileId: z.string().min(1),
  fromBubble: BubbleIndex,
  toBubble: BubbleIndex,
  pathType: PathTypeSchema.optional(),
  pathColor: z.string().default(''),
  pathSize: optionalNumber(z.number().min(1).max(10).optional()),
  pathStyle: BorderStyleSchema.optional(),
  arrowType: ArrowTypeSchema.optional(),
  arrowColor: z.string().default(''),
  arrowSize: optionalNumber(z.number().min(4).max(24).optional()),
  visibility: z
    .enum(['visible', 'visible-locked', 'hidden', 'hidden-locked'])
    .default('visible'),
  labelVisibility: z
    .enum(['visible', 'visible-locked', 'hidden', 'hidden-locked'])
    .default('visible'),
  label: ConnectionLabelSchema.prefault({}),
  // .finite() rejects NaN / ±Infinity from hand-edited files.
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).passthrough();

export type Connection = z.infer<typeof ConnectionSchema>;
export type ConnectionLabel = z.infer<typeof ConnectionLabelSchema>;
