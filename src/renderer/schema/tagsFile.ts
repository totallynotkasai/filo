import { z } from 'zod';

/**
 * `.filo/tags.json` — the single canonical tag store for a vault.
 *
 * - `tags` maps tag *name* (with optional `/` hierarchy) to its visual
 *   metadata (colour, creation time). The tag's name doubles as its
 *   stable identifier on disk.
 * - `fileTags` maps a vault-relative file path to the array of tag names
 *   carried by that file. Any file type may appear as a key — `.md`,
 *   attachments (images, audio, video, PDFs, etc.), and `.board.json` files.
 *
 * Tile tags (tile-on-a-board) are NOT stored here — they live on the tile
 * entry inside `.board.json` so a board file stays self-describing.
 */
export const TagDefinitionSchema = z.object({
  color: z.string(),
  // .finite() rejects NaN / ±Infinity from hand-edited files.
  createdAt: z.number().finite().optional(),
}).passthrough();

export type TagDefinition = z.infer<typeof TagDefinitionSchema>;

/**
 * Current tags-file envelope version. Bump when the on-disk shape
 * changes; mirror the change in `migrateTagsFile` below.
 */
export const CURRENT_TAGS_FILE_VERSION = 1;

export const TagsFileSchema = z.object({
  // `z.number().int()` (not a literal) so a future bump (V2) doesn't fail
  // parse before the migration
  // scaffold runs. The migrator is responsible for translating
  // pre-current shapes; this schema accepts whatever the migrator
  // stamps on the way through.
  version: z.number().int().default(CURRENT_TAGS_FILE_VERSION),
  tags: z.record(z.string(), TagDefinitionSchema).default(() => ({})),
  fileTags: z.record(z.string(), z.array(z.string()).default(() => [])).default(() => ({})),
}).passthrough();

export type TagsFile = z.infer<typeof TagsFileSchema>;

/**
 * Migration scaffold for `.filo/tags.json`. Mirrors
 * `migrateBoardFile` shape so a future V2 bump can land without
 * structural surprises:
 *
 *  - `data`           — the migrated object, version stamped.
 *  - `migratedFrom`   — input version, or null if already current.
 *  - `fromFuture`     — true when input.version exceeds current.
 *  - `noMigrationPath`— true when input.version is below current but
 *                       no `MIGRATION_STEPS` entry covers the gap.
 *
 * Today there's only V1 so the function is effectively a no-op; the
 * point is to lock the call site in place now so the V2 bump becomes
 * a one-file change.
 */
interface MigrateTagsFileResult {
  data: unknown;
  migratedFrom: number | null;
  fromFuture: boolean;
  noMigrationPath: boolean;
}

const TAGS_MIGRATION_STEPS: Record<number, (raw: unknown) => unknown> = {
  // No legacy steps yet — V1 is the earliest shape we ship.
};

function readTagsInputVersion(raw: unknown): { value: number | null; fractional: boolean } {
  if (!raw || typeof raw !== 'object') return { value: null, fractional: false };
  const v = (raw as { version?: unknown }).version;
  if (typeof v !== 'number' || !Number.isFinite(v)) return { value: null, fractional: false };
  if (!Number.isInteger(v)) return { value: v, fractional: true };
  return { value: v, fractional: false };
}

export function migrateTagsFile(raw: unknown): MigrateTagsFileResult {
  const { value: inputVersion, fractional } = readTagsInputVersion(raw);

  if (fractional && inputVersion !== null) {
    return { data: raw, migratedFrom: inputVersion, fromFuture: false, noMigrationPath: true };
  }
  if (inputVersion === CURRENT_TAGS_FILE_VERSION) {
    return { data: raw, migratedFrom: null, fromFuture: false, noMigrationPath: false };
  }
  if (inputVersion !== null && inputVersion > CURRENT_TAGS_FILE_VERSION) {
    return { data: raw, migratedFrom: inputVersion, fromFuture: true, noMigrationPath: false };
  }
  const startVersion = inputVersion ?? CURRENT_TAGS_FILE_VERSION;
  let current: unknown = raw;
  for (let v = startVersion; v < CURRENT_TAGS_FILE_VERSION; v++) {
    const step = TAGS_MIGRATION_STEPS[v];
    if (!step) {
      return { data: raw, migratedFrom: startVersion, fromFuture: false, noMigrationPath: true };
    }
    current = step(current);
  }
  if (current && typeof current === 'object') {
    const next = { ...(current as Record<string, unknown>), version: CURRENT_TAGS_FILE_VERSION };
    return { data: next, migratedFrom: startVersion, fromFuture: false, noMigrationPath: false };
  }
  return { data: current, migratedFrom: startVersion, fromFuture: false, noMigrationPath: false };
}
