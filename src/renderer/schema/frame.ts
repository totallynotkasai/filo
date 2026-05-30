import { z } from 'zod';
import { optionalNumber, uniqueStrings } from './schemaUtils';

/**
 * ── `.passthrough()` contract ────────────────────────────────────────────
 *
 * `FrameSchema`, `FrameStyleSchema`, and their nested position/size objects
 * end in `.passthrough()`. Unknown keys parsed from a newer Filo's
 * `.board.json` survive the load + cache + save round-trip in this build,
 * so opening + re-saving a board produced by a future version does not
 * lose its extra Frame fields. The round-trip is carried by
 * `JSON.parse(JSON.stringify(...))` in `boardSaver.writeBoardFile`.
 *
 * Trade-off: passthrough fields are typed `unknown` and invisible to the
 * schema-typed `Frame` view (line 68 below). Readers that need to inspect
 * a forward-compat field widen the type at the call site. Prefer declaring
 * new fields on the schema over relying on passthrough.
 */

/**
 * Frame per-element style overrides.
 *
 * Every field is optional and falls through to the cascade
 * (board → global → CSS variable) when unset. `backgroundImage` is a
 * live per-element control — the Frame Style popup uploads images
 * into the vault and stores the relative path here.
 *
 * borderStyle / borderWidth / backgroundOpacity are kept optional (no
 * defaults) so the resolver can fall through the per-element layer when
 * the user clicks "Restore to Theme Defaults". A defaulted value would
 * lock the per-element override on and block board/global resolution.
 */
const FrameStyleSchema = z.object({
  backgroundImage: z.string().default(''),
  backgroundOpacity: optionalNumber(z.number().min(0).max(1).optional()),
  borderColor: z.string().default(''),
  borderStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  borderWidth: optionalNumber(z.number().min(0).max(10).optional()),
  headerColor: z.string().optional(),
  bodyColor: z.string().optional(),
  // Per-frame shape override. Mirrors the tile shape vocabulary so the
  // FrameStylePopup can reuse the same Rectangle / Rounded select.
  shape: z.enum(['rectangle', 'rounded']).optional(),
  shadowIntensity: z.number().min(0).max(1).optional(),
  // `null` = inherit from board/global; `true`/`false` = override at this element.
  dynamicContrastText: z.boolean().nullable().optional(),
  // Per-frame title font-size override (px). Seeded from
  // `settings.general.defaultBoardFontSize.frameTitle` at creation.
  fontSizeTitle: z.number().min(8).max(48).optional(),
}).passthrough();

/**
 * Frame — groups tiles visually on the canvas.
 */
export const FrameSchema = z.object({
  id: z.string().min(1),
  boardId: z.string().min(1),
  title: z.string().default('Frame'),
  // Optional rich-text HTML of the title carrying inline marks (colour,
  // highlight, bold, etc.) applied via the GlobalToolbar while the title
  // was being edited in TipTap. `title` stays the canonical plain text;
  // `titleHtml` is the rendered form.
  titleHtml: z.string().optional(),
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }).passthrough(),
  // M18 — accept frames down to 0px on disk rather than rejecting the whole
  // board over a frame the user has visually collapsed. The renderer warns
  // (once) when a loaded frame is smaller than the design-recommended
  // 200×150 minimum; see `warnUndersizedFrames` in boardLoader.
  size: z.object({
    width: z.number().finite().min(0),
    height: z.number().finite().min(0),
  }).passthrough(),
  style: FrameStyleSchema.default({}),
  collapsed: z.boolean().default(false),
  // Sprint A / A14 — `.min(1)` + uniqueness. A duplicate tileId would
  // double-include a tile in the frame's render set and confuse selection
  // (clicking the tile selects the frame twice via different paths).
  tileIds: z.array(z.string().min(1)).default([]).refine(...uniqueStrings('Frame.tileIds')),
  // Phase 31 A6.6 — .finite() rejects NaN / ±Infinity from hand-edited files.
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).passthrough();

export type Frame = z.infer<typeof FrameSchema>;
