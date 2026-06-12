/**
 * frontmatterDelta — the explicit field-level change-set that the Phase-4
 * write path threads instead of a cached full frontmatter object.
 *
 * WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 4 — root cause of the recurring
 * silent-data-loss class: the markdown write path serialised from an in-memory
 * full-object FM cache (`documentStore.getFrontmatter(docId)`) and diffed it
 * against a SEED-TIME frontmatter source. When that cached object disagreed
 * with current disk for any reason unrelated to the user's edit — it went stale
 * (an external editor added a key the cache never saw), was over-cleaned, or was
 * empty because the source didn't parse — the source-preserving CST engine
 * faithfully wrote the WRONG object, dropping untouched keys.
 *
 * The fix makes "never drop an untouched key" STRUCTURAL: a field/popup edit
 * records a `FrontmatterDelta` (the keys the user actually changed), and the
 * write applies it to a FRESH disk read at write time. `nextFm` and the
 * `originalFrontmatter` baseline then derive from the SAME fresh read, so the
 * CST engine rewrites ONLY the delta keys and emits every untouched key —
 * including external additions — byte-for-byte from disk. The full object cache
 * is demoted to a read/display cache; it is never the write source again.
 *
 * Pure module — no store / IPC / DOM access — so it unit-tests in isolation and
 * `lib/vault/markdownFileWriter` (gateway) + `lib/boards/frontmatterWriteScheduler`
 * can both depend on it without a cycle.
 */

/**
 * An explicit field-level change to a `.md` file's YAML frontmatter.
 *
 *  - `set`   — keys to assign a concrete value (the value the user chose).
 *  - `unset` — keys to remove (the user cleared them, or the patch carried an
 *              empty value, matching `mergeFrontmatter`'s cleaning rule).
 *
 * A key never appears in BOTH (see {@link mergeFrontmatterDelta}). Keys absent
 * from the delta are UNTOUCHED — the write sources them from current disk, which
 * is exactly what preserves an externally-added key by construction.
 */
export interface FrontmatterDelta {
  set: Record<string, unknown>;
  unset: string[];
}

/** A delta that changes nothing — the write then preserves disk FM verbatim. */
export function emptyFrontmatterDelta(): FrontmatterDelta {
  return { set: {}, unset: [] };
}

/** True iff the delta touches no keys. */
export function isEmptyFrontmatterDelta(delta: FrontmatterDelta): boolean {
  return Object.keys(delta.set).length === 0 && delta.unset.length === 0;
}

/**
 * Converts a field `patch` (the shape `documentStore.mergeFrontmatter` consumes)
 * into a delta. Mirrors `mergeFrontmatter`'s cleaning rule exactly: an empty
 * string / `null` / `undefined` value means "clear this key", so it becomes an
 * `unset`; every other value is a `set`. So a `{ priority: 'high' }` patch is a
 * set, a `{ priority: '' }` (user cleared priority) is an unset.
 */
export function patchToFrontmatterDelta(patch: Record<string, unknown>): FrontmatterDelta {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const key of Object.keys(patch)) {
    const v = patch[key];
    if (v === '' || v === null || v === undefined) unset.push(key);
    else set[key] = v;
  }
  return { set, unset };
}

/**
 * Diffs a full `before` frontmatter object against a full `after` object and
 * returns the MINIMAL delta (only the keys that changed). Used by the Properties
 * popup, which works in whole-object terms: `before` is the popup's open-time
 * snapshot and `after` is its current rows, so a key the popup never touched
 * (incl. one an external editor added since the popup opened, which is in
 * neither snapshot) is absent from the delta and the write preserves it from
 * disk.
 *
 * Cleaning rule matches `patchToFrontmatterDelta`: an empty/null/undefined value
 * in `after` is a clear → `unset` (only when the key actually carried a value in
 * `before`; a key that was empty in both is a no-op). Equality is a conservative
 * structural compare — a false "changed" only re-sets a key to its own value,
 * which the CST engine still byte-preserves, so over-inclusion is harmless while
 * under-inclusion (missing a real change) is not.
 */
export function diffToFrontmatterDelta(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FrontmatterDelta {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = after[key];
    const aIsValue = key in after && a !== '' && a !== null && a !== undefined;
    if (aIsValue) {
      if (!valuesShallowEqual(before[key], a)) set[key] = a;
    } else {
      const b = before[key];
      const bWasValue = key in before && b !== '' && b !== null && b !== undefined;
      if (bWasValue) unset.push(key);
    }
  }
  return { set, unset };
}

/**
 * Applies a delta to a `base` frontmatter object (typically a FRESH disk parse),
 * returning a NEW object. `set` keys are assigned, then `unset` keys removed —
 * so a key that somehow appears in both resolves to removed (defensive; the
 * delta builders never produce that, and `mergeFrontmatterDelta` enforces it).
 * Untouched keys pass through verbatim, which is the whole point.
 */
export function applyFrontmatterDelta(
  base: Record<string, unknown>,
  delta: FrontmatterDelta,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(delta.set)) out[key] = delta.set[key];
  for (const key of delta.unset) delete out[key];
  return out;
}

/**
 * Folds delta `b` ON TOP OF delta `a` (b applied after a), so coalesced field
 * edits to one path accumulate into a single delta. A key set in `b` overrides
 * any prior set/unset for it in `a`, and vice-versa, so the result never lists a
 * key in both `set` and `unset`. Used by the frontmatter scheduler's per-path
 * accumulator when several debounced field edits collapse into one write.
 */
export function mergeFrontmatterDelta(a: FrontmatterDelta, b: FrontmatterDelta): FrontmatterDelta {
  const set: Record<string, unknown> = { ...a.set };
  const unset = new Set(a.unset);
  for (const key of Object.keys(b.set)) {
    set[key] = b.set[key];
    unset.delete(key);
  }
  for (const key of b.unset) {
    delete set[key];
    unset.add(key);
  }
  return { set, unset: [...unset] };
}

/**
 * Conservative structural equality for the popup diff. Object key order is not
 * semantically meaningful in YAML so it is ignored; arrays compare
 * order-sensitively (a reordered list IS a user edit in the popup). Anything
 * this can't confidently prove equal is treated as different (the safe
 * direction — see `diffToFrontmatterDelta`).
 */
function valuesShallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // 5.1 (Audit-17) — `NaN !== NaN`, but two `.nan` values are the same data;
  // treat them equal so a `.nan` key isn't spuriously diffed as changed on every
  // unrelated popup edit (mirrors `valuesEqual` in frontmatterEngine.ts).
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesShallowEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
    if (!valuesShallowEqual(ao[key], bo[key])) return false;
  }
  return true;
}
