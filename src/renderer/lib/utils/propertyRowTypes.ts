/**
 * Pure type-detection + value-coercion helpers for the Properties popup's
 * key/value rows. Extracted from `PropertiesPopup.svelte` so the round-trip
 * logic (frontmatter value → typed row → frontmatter value) is unit-testable
 * without mounting the component, per the "lib holds pure logic, components are
 * UI only" rule.
 */

export type PropType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'list'
  | 'tag'
  | 'status'
  | 'raw';

/**
 * True iff a typed row can hold `value` WITHOUT losing
 * information. The popup's scalar / list / tag rows only round-trip primitives
 * (and `null`) and string-only arrays; everything else — a nested object/array,
 * or an array carrying a non-string item (numbers/booleans/objects) — would be
 * mangled by `String()` coercion (`{lat,lng}` → `"[object Object]"`,
 * `[2024,2025]` → `["2024","2025"]`). Those values ride the verbatim `raw` row
 * instead, which round-trips them untouched and renders read-only.
 */
export function isRepresentable(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.every((v) => typeof v === 'string');
  return typeof value !== 'object'; // primitives ok; plain objects are not
}

/**
 * Classifies a frontmatter value into the editor row type the popup renders.
 *
 * Only a PURE `YYYY-MM-DD` value is classified as `date`. A datetime
 * (`2025-01-15T10:30:00Z`, or any value carrying a `T` / timezone component) is
 * deliberately left as `text`: the `date` row renders an `<input type="date">`
 * and `valueForRow` slices the value to its first 10 chars, which would drop
 * the time + timezone on the next write.
 *
 * A value the typed rows can't represent losslessly (see
 * `isRepresentable`) is classified `raw` BEFORE the array/list branch, so a
 * numeric/boolean/object array or a nested map isn't coerced through `String()`.
 */
export function detectType(key: string, value: unknown): PropType {
  const k = key.trim().toLowerCase();
  // Only a string-only array is a `tag` row; a `tags: [1, 2]` array (non-string
  // items) falls through to `raw` so its numbers aren't stringified.
  if (k === 'tags' && Array.isArray(value) && value.every((v) => typeof v === 'string')) return 'tag';
  // `status` key auto-detects as the status type for any string value, so
  // custom values written to frontmatter round-trip correctly through the
  // popup UI without forcing the user to re-pick the type each open.
  if (k === 'status' && typeof value === 'string') return 'status';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  // Non-representable values become read-only `raw` rows. MUST precede the
  // array/list branch so a numeric/boolean/object array isn't String()-coerced.
  if (!isRepresentable(value)) return 'raw';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') {
    // ISO date-only detection — YYYY-MM-DD with NO time/zone component. A value
    // with a `T` (or space-separated time) falls through to `text` so it isn't
    // truncated to date-only on write.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  }
  return 'text';
}

/**
 * Coerces a raw frontmatter value into the shape the typed row's editor expects.
 * The `date` branch only ever receives a pure `YYYY-MM-DD` value (see
 * `detectType`), so its `slice(0, 10)` is a no-op for well-formed dates.
 *
 * The `raw` branch returns the value VERBATIM (no `String()` /
 * coercion), so a nested object/array round-trips through the popup identically
 * and is absent from the write delta (preserved from disk).
 */
export function valueForRow(value: unknown, type: PropType): unknown {
  switch (type) {
    case 'raw':
      return value;
    case 'boolean':
      return Boolean(value);
    case 'number':
      return typeof value === 'number' ? value : Number(value) || 0;
    case 'tag':
    case 'list':
      if (Array.isArray(value)) return value.map((v) => String(v));
      if (typeof value === 'string') return value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      return [];
    case 'date':
      if (typeof value === 'string') return value.slice(0, 10);
      return '';
    case 'status':
      return typeof value === 'string' && value.length > 0 ? value : 'todo';
    default:
      return typeof value === 'string' ? value : String(value ?? '');
  }
}
