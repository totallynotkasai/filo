import { z } from 'zod';

/**
 * Coerces a value to a number, accepting both numbers and numeric strings.
 *
 * Behaviour, by input case:
 *   - undefined  → fallback (outer `.optional()` accepts, final transform
 *                  folds the resulting `undefined` into fallback).
 *   - null       → REJECTED at the union (no null branch).
 *   - NaN        → REJECTED at the `z.number()` branch (Zod default).
 *   - ±Infinity  → passed through unchanged; REJECTED at the caller's
 *                  downstream `.pipe(z.number().finite())` gate (see below).
 *   - unparseable string → NaN (via `parseFloat`); REJECTED at the caller's
 *                  downstream `.pipe(z.number().finite())` gate (see SC-1).
 *   - numeric string     → parsed via `parseFloat`.
 *
 * DECISION (2026-05-28, M2): ±Infinity now fails loud rather than folding
 * to the fallback. Previously the final transform replaced a non-finite
 * number with `fallback` and then persisted that on the next save — silently
 * rewriting a hand-edited coordinate (e.g. `1e999` → Infinity) to 240/160,
 * which contradicted the loader's otherwise fail-loud stance for corrupt
 * data. A board with an Infinity coord now routes to `failedBoards` + a
 * recovery snapshot, exactly like a NaN coord. Both share the rationale that
 * a non-finite coordinate poisons the rbush spatial index, so surfacing the
 * board for recovery beats quietly mutating the user's file.
 *
 * DECISION (2026-05-29, SC-1): an unparseable size string (e.g. `"wide"`)
 * now also fails loud. Previously the string branch folded a `NaN` parse to
 * `fallback`, silently substituting 240/160 for a corrupt hand-edited size —
 * inconsistent with the ±Infinity stance above. The branch now returns the
 * raw `parseFloat` result (NaN for unparseable input), so the downstream
 * `.finite()` gate rejects it and the board routes to `failedBoards` +
 * recovery. Numeric strings (`"300"`) still parse and pass.
 *
 * Contract: callers MUST chain `.pipe(z.number().finite()…)` — that gate is
 * what rejects the passed-through ±Infinity / NaN. Every call site does
 * (tile.ts, placement.ts). The final transform here only folds the legitimate
 * `undefined` (absent field) case into the fallback; a finite number, ±Infinity,
 * or NaN-from-unparseable-string passes through verbatim to be rejected downstream.
 */
export const coerceToNumber = (fallback: number) =>
  z.union([
    z.number(),
    z.string().transform(v => parseFloat(v)),
  ]).optional().transform(v => (v === undefined ? fallback : v));

/**
 * Preprocessor that turns the empty string / null / unparseable / non-finite
 * inputs into `undefined` and parses numeric strings into numbers. Compose
 * with `z.number().min(...).max(...).optional()` for cascade-participating
 * numeric fields where a baked-in default would lock the per-element
 * override on. NaN and ±Infinity are filtered out at this layer because
 * downstream `.finite()` would otherwise raise a schema-invalid error and
 * abort the whole board load.
 */
const numericCoerce = (v: unknown): unknown => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return undefined;
  return v;
};

/**
 * Cascade-friendly numeric field: numbers and numeric strings pass through,
 * undefined / null / '' stay undefined so the resolver can fall through to
 * the next layer. The downstream `z.number()` chain validates min/max.
 */
export const optionalNumber = (
  inner: z.ZodTypeAny = z.number().optional(),
) => z.preprocess(numericCoerce, inner);

/**
 * Array `.refine` that asserts the values selected by `pick` are unique across
 * the array. Pairs with `id: z.string().min(1)` so a board file with duplicate
 * ids on its frames/groups/sections/columns/etc. lands in `failedBoards` +
 * recovery snapshot rather than producing a live canvas where two entities
 * share an id — which silently breaks selection, undo, and rename cascade.
 *
 * @example
 *   z.array(FrameSchema).refine(...uniqueBy('id', 'frames'))
 *
 * The error message names the collection so the recovery toast can point the
 * user at the right slice of the board file.
 */
/**
 * Sprint A / A14 — array `.refine` predicate for flat ID arrays. Mirrors
 * `uniqueBy` but for `z.array(z.string())` (no object key to project
 * through). Use alongside `.min(1)` on the string element so empty IDs
 * are rejected at element-level. The duplicate check fires only when
 * every element is non-empty; the per-element `.min(1)` covers the
 * empty-string case with a more precise error.
 */
export const uniqueStrings = (
  collectionName: string,
): [(values: string[]) => boolean, { message: string }] => [
  (values: string[]) => new Set(values).size === values.length,
  { message: `Duplicate id in ${collectionName}` },
];

/**
 * Sprint C / C7 — pattern matching the nanoid alphabet
 * (alphanumerics + `_` + `-`). The minimum-length check is deferred
 * to a separate `.min(1)`; an 8-char floor would break a swathe of
 * existing test fixtures that use 6-char ids like `tile_x` / `frame_x`
 * — the bug the plan targets is empty / whitespace / special-character
 * keys, not short test ids. Production ids come from
 * `lib/utils/ids.ts` (`createId()` → `nanoid(12)`, occasionally with a
 * semantic prefix like `sec_`) and easily satisfy this even at the
 * looser bound.
 */
export const NANOID_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * Re-usable Zod string schema for record keys that must look like an
 * id minted by `lib/utils/ids.ts`.
 */
export const idString = z.string().min(1).regex(NANOID_REGEX, {
  message: 'must be a nanoid-style id (alphanumerics, _, -, non-empty)',
});

export const uniqueBy = <T,>(
  pick: keyof T | ((value: T) => string | number),
  collectionName: string,
): [(values: T[]) => boolean, { message: string }] => {
  // The `as` cast is the price of the generic — the keyof T branch hands us
  // T[keyof T] but every call site in the codebase points at a string id
  // field. Narrowing inside the union still requires the boundary cast.
  const get = typeof pick === 'function'
    ? pick
    : (value: T) => value[pick] as unknown as string | number; // allow-cast: keyof T → string|number boundary, runtime-narrowed by null check
  return [
    (values: T[]) => {
      const seen = new Set<string | number>();
      for (const v of values) {
        const k = get(v);
        if (k == null) continue;
        if (seen.has(k)) return false;
        seen.add(k);
      }
      return true;
    },
    { message: `Duplicate id in ${collectionName}` },
  ];
};
