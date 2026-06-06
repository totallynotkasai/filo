import type { FileMetadata } from './vaultIndex';
import type { V7BoardFileData } from '../boards/boardSaver';
import type { TileDefinition } from '../../schema/index';
import { normalizeTagsField, orderPreservingTagsField } from '../utils/normalizeTagsField';
import { normalizeVaultRelative } from '../utils/path';

/**
 * Fields that may appear on both a tile-like cache and in a .md file's
 * frontmatter. When the two disagree, frontmatter wins per the project
 * source-of-truth rule (CLAUDE.md: "Frontmatter is canonical").
 */
export const SYNCED_FIELDS = [
  'title',
  'tags',
  'completed',
  // Audit-11 B-INT-L1 — `date` is intentionally NOT synced. No tile / card /
  // task reads a cached `date` (only `dueDate` / `startDate` drive display +
  // smart-list filters), yet keeping it here let `reconcileBoardCacheWith-
  // Frontmatter` seed-and-write a `date` field onto any text tile backing a
  // note whose `.md` carried a `date:` key (ubiquitous in Obsidian-style
  // vaults) — leaking a frontmatter-canonical value into `.board.json`. The
  // schema's `TASK_METADATA_FIELDS` strip-on-load would then fire a warn-loop
  // on every reconcile. Dropping it from the synced set closes the leak at its
  // source (the reconcile never sets it, so it's never written). Do NOT re-add
  // without also wiring a real cached-`date` reader + the strip-list entry.
  'dueDate',
  'dueTime',
  'startDate',
  'priority',
  'status',
  'parent',
  'recurrence',
  'recurrenceMode',
] as const;

export type SyncedField = (typeof SYNCED_FIELDS)[number];

/**
 * A single divergence between a cached tile-like object and the file on disk.
 * The consumer decides how to apply the `canonical` value to its own data
 * structure — this library doesn't mutate anything.
 */
export interface FrontmatterDivergence {
  field: SyncedField;
  cached: unknown;
  canonical: unknown;
}

/**
 * Lightweight subset of tile state that participates in frontmatter sync.
 * Callers pass the fields they have — missing entries are treated as "no
 * cached value" (canonical frontmatter then becomes authoritative).
 */
export type TileLikeCache = Partial<Record<SyncedField, unknown>>;

/**
 * Re-export of the canonical normaliser so existing callers continue to
 * resolve `normalizeTags` from this module. The implementation lives in
 * `lib/utils/normalizeTagsField.ts` and is shared with `tagRewriter`.
 */
export const normalizeTags = normalizeTagsField;

/**
 * YAML parsers (gray-matter) auto-coerce ISO date strings to `Date`. We keep
 * dates as strings so they round-trip through JSON and compare stably.
 */
function normalizeScalar(value: unknown): unknown {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return value;
}

function valuesEqual(field: SyncedField, a: unknown, b: unknown): boolean {
  if (field === 'tags') {
    const ax = normalizeTags(a);
    const bx = normalizeTags(b);
    return ax.length === bx.length && ax.every((v, i) => v === bx[i]);
  }
  if (a === b) return true;
  if (a == null && b === '') return true;
  if (a === '' && b == null) return true;
  return false;
}

/**
 * Extracts the canonical value for each synced field from the file's
 * frontmatter + metadata. `title` falls back to the first heading or the
 * filename so every file has a canonical title even without frontmatter.
 */
export function canonicalValues(metadata: FileMetadata): Partial<Record<SyncedField, unknown>> {
  const fm = metadata.frontmatter;
  const out: Partial<Record<SyncedField, unknown>> = {};

  out.title = metadata.title;
  // Authored order (not sorted) so a reconciled tile def's tag chips match
  // the order in the .md. Divergence comparison still sorts via valuesEqual,
  // so order here is purely cosmetic for the cache. (7.4)
  out.tags = orderPreservingTagsField(fm.tags ?? metadata.tags);

  if ('completed' in fm) out.completed = normalizeScalar(fm.completed);
  // Audit-11 B-INT-L1 — `date` deliberately omitted (see SYNCED_FIELDS note).
  if ('dueDate' in fm) out.dueDate = normalizeScalar(fm.dueDate);
  if ('dueTime' in fm) out.dueTime = normalizeScalar(fm.dueTime);
  if ('startDate' in fm) out.startDate = normalizeScalar(fm.startDate);
  if ('priority' in fm) out.priority = normalizeScalar(fm.priority);
  if ('status' in fm) out.status = normalizeScalar(fm.status);
  if ('parent' in fm) out.parent = normalizeScalar(fm.parent);
  if ('recurrence' in fm) out.recurrence = normalizeScalar(fm.recurrence);
  if ('recurrenceMode' in fm) out.recurrenceMode = normalizeScalar(fm.recurrenceMode);

  return out;
}

/**
 * Compares a cached tile snapshot against a file's canonical values.
 * Returns the list of fields that diverge. If none, the cache is in sync.
 */
export function detectDivergence(
  cache: TileLikeCache,
  metadata: FileMetadata,
): FrontmatterDivergence[] {
  const canonical = canonicalValues(metadata);
  const divergences: FrontmatterDivergence[] = [];

  for (const field of SYNCED_FIELDS) {
    if (!(field in canonical)) continue;
    // Only reconcile fields the cache actually tracks. Fields the cache
    // never had (`field in cache === false`) aren't drift — they're "not
    // this cache's concern" and adding them would pollute the object.
    if (!(field in cache)) continue;
    const cachedValue = cache[field];
    const canonicalValue = canonical[field];
    if (!valuesEqual(field, cachedValue, canonicalValue)) {
      divergences.push({ field, cached: cachedValue, canonical: canonicalValue });
    }
  }

  return divergences;
}

/**
 * Applies frontmatter-sourced values onto a shallow copy of the cache.
 * Only fields listed in `divergences` are overwritten; everything else is
 * preserved. Returns the updated object.
 *
 * Use this from the board loader / watcher after `detectDivergence` flags a
 * drift: the returned object is what should be written back to the board
 * JSON cache and scheduled for a debounced save.
 */
export function applyCanonical<T extends TileLikeCache>(
  cache: T,
  divergences: FrontmatterDivergence[],
): T {
  if (divergences.length === 0) return cache;
  const next = { ...cache } as T;
  for (const d of divergences) {
    (next as Record<string, unknown>)[d.field] =
      d.field === 'tags' ? orderPreservingTagsField(d.canonical) : d.canonical;
  }
  return next;
}

/**
 * Resolves the canonical state for a single cached tile in one step.
 * Returns the patched cache plus the list of applied divergences (for
 * logging / debugging). If no divergences are found, the original cache is
 * returned by reference.
 */
export function reconcile<T extends TileLikeCache>(
  cache: T,
  metadata: FileMetadata,
): { next: T; changes: FrontmatterDivergence[] } {
  const changes = detectDivergence(cache, metadata);
  if (changes.length === 0) return { next: cache, changes: [] };
  return { next: applyCanonical(cache, changes), changes };
}

/**
 * Returns true when a tile definition is backed by the given vault-relative
 * Markdown path. Text tiles back to a top-level `${title}.md` file by
 * convention; non-text tiles use the explicit `file` / `filePath` field.
 *
 * Path comparison is case-insensitive with forward-slash normalisation so
 * Windows + macOS clients agree.
 */
export function tileBacksMarkdownPath(
  def: TileDefinition,
  relPath: string,
): boolean {
  const target = normalizeVaultRelative(relPath);
  if (!target) return false;

  const d = def as Record<string, unknown>;
  const explicit = (d.file as string) ?? (d.filePath as string) ?? '';
  if (typeof explicit === 'string' && explicit.length > 0) {
    if (normalizeVaultRelative(explicit) === target) return true;
  }

  if (def.type === 'text') {
    const candidate = `${(def.title ?? '').trim()}.md`.toLowerCase();
    if (candidate === target) return true;
  }
  return false;
}

export interface BoardCacheReconcileResult {
  /** Boards that received at least one tile-def update. */
  changedBoardIds: string[];
  /** Per-board tile changes for logging / tests. */
  perBoard: Record<string, Array<{ tileId: string; changes: FrontmatterDivergence[] }>>;
}

/**
 * Walks every loaded board's tile definitions, finds tiles backed by the
 * Markdown file at `relPath`, and reconciles their cached metadata against
 * the file's canonical frontmatter. Mutates `boardCache` entries in place
 * (replaces the inner `tileDefs` map for changed boards so Svelte 5
 * reactivity sees the change) and returns which boards now need a write.
 *
 * Pure-ish: does not perform IPC or schedule writes. The caller is
 * responsible for calling `boardSaver.scheduleBoardWrite` for each
 * `changedBoardIds` entry.
 */
export function reconcileBoardCacheWithFrontmatter(
  boardCache: Record<string, V7BoardFileData>,
  relPath: string,
  metadata: FileMetadata,
  options?: {
    /**
     * 6.2.H9 — when false, suppresses the `patched.updatedAt = Date.now()`
     * stamp on reconciled tiles. The on-open batch reconcile is not a
     * user edit (the disk frontmatter was the canonical source we synced
     * to), so the in-app "last touched" timestamp shouldn't bump. The
     * live event path still stamps (it IS a user-initiated external
     * edit), so the default stays `true`.
     */
    stampUpdatedAt?: boolean;
  },
): BoardCacheReconcileResult {
  const stampUpdatedAt = options?.stampUpdatedAt ?? true;
  const changedBoardIds: string[] = [];
  const perBoard: Record<string, Array<{ tileId: string; changes: FrontmatterDivergence[] }>> = {};

  for (const [boardId, data] of Object.entries(boardCache)) {
    const defs = data.tileDefs ?? {};
    let changedThisBoard = false;
    const updates: Record<string, TileDefinition> = {};

    for (const [tileId, def] of Object.entries(defs)) {
      if (!tileBacksMarkdownPath(def, relPath)) continue;

      // Build the cache subset that participates in sync. Include a key for
      // every field already on the def, PLUS — Audit 2.3 — every field the
      // canonical frontmatter carries even when the def never had it, seeded
      // as an explicit `undefined`. Without that seed, detectDivergence's
      // `field in cache` guard skips a field the tile didn't previously track,
      // so a field added to the .md in an external editor (e.g. `dueDate` /
      // `priority` / `status` on a task) wouldn't reach the live cache until a
      // board reload — smart-list filters/sort would silently ignore it mid-
      // session. Fields absent from BOTH the def and the frontmatter stay out,
      // so we never invent task fields the file doesn't actually have.
      const cacheSubset: TileLikeCache = {};
      const d = def as Record<string, unknown>;
      const canonical = canonicalValues(metadata);
      for (const field of SYNCED_FIELDS) {
        if (field in d) cacheSubset[field] = d[field];
        else if (field in canonical) cacheSubset[field] = undefined;
      }

      const { changes } = reconcile(cacheSubset, metadata);
      if (changes.length === 0) continue;

      const patched: Record<string, unknown> = { ...def };
      // applyCanonical normalises canonical values (notably tag arrays) before we copy them in.
      const patchedSync = applyCanonical(cacheSubset, changes);
      for (const c of changes) patched[c.field] = patchedSync[c.field];
      if (stampUpdatedAt) patched.updatedAt = Date.now();

      updates[tileId] = patched as TileDefinition;
      perBoard[boardId] = perBoard[boardId] ?? [];
      perBoard[boardId].push({ tileId, changes });
      changedThisBoard = true;
    }

    if (changedThisBoard) {
      data.tileDefs = { ...defs, ...updates };
      changedBoardIds.push(boardId);
    }
  }

  return { changedBoardIds, perBoard };
}
