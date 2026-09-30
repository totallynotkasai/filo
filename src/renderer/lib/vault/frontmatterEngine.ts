import { Document } from 'yaml';

/**
 * Shared frontmatter value helpers — structural equality + scalar / pair YAML
 * serialization — used by the source-preserving CST-operations patch engine
 * ({@link import('./frontmatterCstModel').patchFrontmatterSourceCst}) and the
 * external-edit conflict resolver.
 */

/**
 * Structural equality for frontmatter values (scalars, arrays, plain objects).
 *
 * Key-order-insensitive for plain objects: a map `{author, date}` on disk must
 * equal an in-memory `{date, author}`, or the engine would rewrite the node
 * and lose comments on its unchanged keys.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // `NaN !== NaN` by IEEE-754, but two `.nan` frontmatter values are the SAME
  // data. Otherwise an untouched `.nan` key looks changed on every edit and
  // gets rewritten (losing its inner comments / formatting).
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  // A Date is `typeof 'object'` with NO own keys, so the generic object branch
  // below would compare two DIFFERENT Dates as equal and silently drop a date
  // edit. Compare Dates by instant. (Reads produce strings today; defensive.)
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && +a === +b;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    if (typeof b !== 'object' || Array.isArray(b)) return false;
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
      if (!valuesEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Coerce a residual `Date` to the plain `YYYY-MM-DD` form so a changed date
 * value never re-emits as an ISO timestamp. Reads produce strings under the
 * `yaml` core schema, so this is defence for a `Date` reaching the serializer.
 */
function coerceForEmit(value: unknown): unknown {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString().slice(0, 10)
    : value;
}

/**
 * Serialises a single primitive value to its YAML scalar text (no key, no
 * trailing newline), quoting exactly when YAML requires it. Uses the `yaml`
 * package — the SAME serializer the read path parses with — so a value-only
 * splice produces a scalar that re-parses to the intended value and matches the
 * quoting of the untouched keys around it (e.g. an unquoted `2025-01-15`, not a
 * defensively-quoted `'2025-01-15'`). `lineWidth: 0` disables folding so a long
 * value never wraps to multi-line.
 *
 * The CST engine emits a changed scalar's bytes via this helper rather than
 * `CST.setScalarValue`: that API keeps the existing plain style, so the STRING
 * `"123"` would re-emit unquoted `123` and re-parse as the NUMBER 123 (a type
 * corruption); this serializer quotes it correctly.
 */
export function serializeScalar(value: unknown): string {
  return new Document(coerceForEmit(value)).toString({ lineWidth: 0 }).replace(/\n$/, '');
}

/**
 * Serialises one `key: value` pair to a YAML block (with its trailing newline)
 * for a changed collection / type-change or a freshly-added key, via the same
 * `yaml`-package serializer as {@link serializeScalar}. The CST engine rebuilds
 * a changed-collection / added key from this exact text.
 *
 * A `null` value is written as a bare `key:`, the way templates from other
 * apps spell an empty key (an undo puts one back like that), never `key: null`.
 */
export function serializeKeyValue(key: string, value: unknown): string {
  if (value === null) return new Document({ [key]: null }).toString({ lineWidth: 0, nullStr: '' });
  return new Document({ [key]: coerceForEmit(value) }).toString({ lineWidth: 0 });
}
