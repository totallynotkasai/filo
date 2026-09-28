/**
 * frontmatterDelta — the explicit field-level change-set that field/popup
 * writes thread instead of a cached full frontmatter object.
 *
 * Writing a cached full object is unsafe: if it disagrees with disk for any
 * reason unrelated to the user's edit (stale, over-cleaned, empty), the CST
 * engine faithfully writes the WRONG object and drops untouched keys. Instead
 * an edit records a `FrontmatterDelta` (the keys the user actually changed),
 * and the write applies it to a FRESH disk read at write time, so every
 * untouched key — including external additions — is emitted byte-for-byte
 * from disk. The full object cache is a read/display cache only.
 *
 * Pure module — no store / IPC / DOM access — so it unit-tests in isolation and
 * `lib/notes/noteFile` + `lib/notes/noteWriter` + the field commands
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

/** True iff the delta touches no keys. */
export function isEmptyFrontmatterDelta(delta: FrontmatterDelta): boolean {
  return Object.keys(delta.set).length === 0 && delta.unset.length === 0;
}

/**
 * Converts a field `patch` (a command's key → value map)
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
 * key in both `set` and `unset`. Used by the note writer's per-path queue
 * when several debounced field edits collapse into one write.
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
 * What is left of the queued delta `queued` once `written` has landed: every
 * key `written` already set to the same value, or already removed, is
 * dropped. Keys set again with a new value (or newly named) stay. Re-applying
 * a landed key would overwrite a value another program gave it since. Null
 * when nothing is left.
 */
export function subtractWrittenDelta(queued: FrontmatterDelta, written: FrontmatterDelta): FrontmatterDelta | null {
  const set: Record<string, unknown> = {};
  for (const key of Object.keys(queued.set)) {
    const landed = Object.prototype.hasOwnProperty.call(written.set, key)
      && valuesShallowEqual(written.set[key], queued.set[key]);
    if (!landed) set[key] = queued.set[key];
  }
  const unset = queued.unset.filter((key) => !written.unset.includes(key));
  const rest = { set, unset };
  return isEmptyFrontmatterDelta(rest) ? null : rest;
}

/**
 * Conservative structural equality for `subtractWrittenDelta`. Object key
 * order is not semantically meaningful in YAML so it is ignored; arrays compare
 * order-sensitively (a reordered list is a different value). Anything this
 * can't confidently prove equal is treated as different, the safe direction:
 * a key wrongly kept is only re-set to its own value.
 */
function valuesShallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // `NaN !== NaN`, but two `.nan` values are the same data;
  // treat them equal so a landed `.nan` key isn't re-applied as if it were
  // still queued (mirrors `valuesEqual` in frontmatterEngine.ts).
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
