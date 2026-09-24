import { z } from 'zod';
import { TileStyleSchema } from './tile';
import { ConnectionLabelSchema } from './connection';

// .finite() rejects NaN / ±Infinity. A template captured
// while a tile had a transient NaN-coord (or a hand-edited template file)
// would otherwise re-instantiate tiles at undefined positions.
const RelativePositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).passthrough();

const SizeSchema = z.object({
  width: z.number().finite().min(1),
  height: z.number().finite().min(1),
}).passthrough();

const TileTypeSchema = z.enum([
  'text',
  'image',
  'video',
  'file',
  'audio',
  'link',
  'iframe',
  'timer',
]);

export const LayoutTemplateTileSchema = z.object({
  type: TileTypeSchema,
  relativePosition: RelativePositionSchema,
  size: SizeSchema,
  style: TileStyleSchema,
  config: z.record(z.string(), z.unknown()).optional(),
  /**
   * Anonymous grouping key for text tiles that referenced the same backing
   * `.md` file at capture time. Tiles with the same `contentGroup` share a
   * single fresh `.md` file on instantiation; tiles with distinct (or
   * absent) groups each get their own file. The key is local to the
   * template — it does not leak the source `contentId`.
   */
  contentGroup: z.string().optional(),
}).passthrough();

/**
 * Connection captured alongside a layout template. Endpoints reference tiles
 * by their index in `LayoutTemplate.tiles` (not by id), because template
 * tiles are minted with fresh ids on instantiation. Edges that crossed the
 * selection boundary at capture time are dropped — a template is
 * self-contained.
 */
export const LayoutTemplateConnectionSchema = z.object({
  fromTileIndex: z.number().int().min(0),
  toTileIndex: z.number().int().min(0),
  fromBubble: z.number().int().min(0).max(7),
  toBubble: z.number().int().min(0).max(7),
  // Path/arrow style fields are optional so a re-instantiated template's
  // connections fall through the cascade just like a freshly-drawn
  // connection. See ConnectionSchema docstring for the rationale.
  pathType: z.enum(['curved', 'straight', 'elbow', 'smart']).optional(),
  pathColor: z.string().default(''),
  pathSize: z.number().min(1).max(10).optional(),
  pathStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  arrowType: z.enum(['none', 'start', 'end', 'both']).optional(),
  arrowColor: z.string().default(''),
  arrowSize: z.number().min(4).max(24).optional(),
  visibility: z
    .enum(['visible', 'visible-locked', 'hidden', 'hidden-locked'])
    .default('visible'),
  labelVisibility: z
    .enum(['visible', 'visible-locked', 'hidden', 'hidden-locked'])
    .default('visible'),
  label: ConnectionLabelSchema.prefault({}),
}).passthrough();

/**
 * Current layout-template version. Bump when the on-disk shape changes;
 * mirror the change in `migrateLayoutTemplate` below.
 */
export const CURRENT_LAYOUT_TEMPLATE_VERSION = 1;

export const LayoutTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  // `z.number().int()` (not a literal) so a future V2 bump doesn't fail parse
  // before the migration scaffold runs. See `migrateLayoutTemplate` below.
  version: z.number().int().default(CURRENT_LAYOUT_TEMPLATE_VERSION),
  // .finite() rejects NaN / ±Infinity from hand-edited files.
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  boundingBox: z.object({
    // .finite() guard so a corrupted template's bounding
    // box can't translate into NaN bounds on instantiation.
    width: z.number().finite().min(0),
    height: z.number().finite().min(0),
  }),
  tiles: z.array(LayoutTemplateTileSchema),
  /**
   * Connections between captured tiles. Optional so legacy templates saved
   * before this field existed continue to parse — they simply instantiate
   * with no connections, matching pre-feature behaviour.
   */
  connections: z.array(LayoutTemplateConnectionSchema).optional(),
}).passthrough();

export type LayoutTemplateTile = z.infer<typeof LayoutTemplateTileSchema>;
export type LayoutTemplateConnection = z.infer<typeof LayoutTemplateConnectionSchema>;
export type LayoutTemplate = z.infer<typeof LayoutTemplateSchema>;

/**
 * Migration scaffold for layout templates. Mirrors
 * `migrateBoardFile` / `migrateTagsFile`. Today only V1 exists so the
 * function is effectively a no-op; the scaffold lets a V2 bump land in
 * one file rather than scattering version-aware logic across callers.
 */
export interface MigrateLayoutTemplateResult {
  data: unknown;
  migratedFrom: number | null;
  fromFuture: boolean;
  noMigrationPath: boolean;
}

const LAYOUT_TEMPLATE_MIGRATION_STEPS: Record<number, (raw: unknown) => unknown> = {
  // No legacy steps — V1 is the earliest shipped shape.
};

function readLayoutTemplateInputVersion(raw: unknown): { value: number | null; fractional: boolean } {
  if (!raw || typeof raw !== 'object') return { value: null, fractional: false };
  const v = (raw as { version?: unknown }).version;
  if (typeof v !== 'number' || !Number.isFinite(v)) return { value: null, fractional: false };
  if (!Number.isInteger(v)) return { value: v, fractional: true };
  return { value: v, fractional: false };
}

export function migrateLayoutTemplate(raw: unknown): MigrateLayoutTemplateResult {
  const { value: inputVersion, fractional } = readLayoutTemplateInputVersion(raw);

  if (fractional && inputVersion !== null) {
    return { data: raw, migratedFrom: inputVersion, fromFuture: false, noMigrationPath: true };
  }
  if (inputVersion === CURRENT_LAYOUT_TEMPLATE_VERSION) {
    return { data: raw, migratedFrom: null, fromFuture: false, noMigrationPath: false };
  }
  if (inputVersion !== null && inputVersion > CURRENT_LAYOUT_TEMPLATE_VERSION) {
    return { data: raw, migratedFrom: inputVersion, fromFuture: true, noMigrationPath: false };
  }
  const startVersion = inputVersion ?? CURRENT_LAYOUT_TEMPLATE_VERSION;
  let current: unknown = raw;
  for (let v = startVersion; v < CURRENT_LAYOUT_TEMPLATE_VERSION; v++) {
    const step = LAYOUT_TEMPLATE_MIGRATION_STEPS[v];
    if (!step) {
      return { data: raw, migratedFrom: startVersion, fromFuture: false, noMigrationPath: true };
    }
    current = step(current);
  }
  if (current && typeof current === 'object') {
    const next = { ...(current as Record<string, unknown>), version: CURRENT_LAYOUT_TEMPLATE_VERSION };
    return { data: next, migratedFrom: startVersion, fromFuture: false, noMigrationPath: false };
  }
  return { data: current, migratedFrom: startVersion, fromFuture: false, noMigrationPath: false };
}
