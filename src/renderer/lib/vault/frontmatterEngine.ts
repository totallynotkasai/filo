import { Document } from 'yaml';

/**
 * Shared frontmatter value helpers — structural equality + scalar / pair YAML
 * serialization — used by the source-preserving CST-operations patch engine
 * ({@link import('./frontmatterCstModel').patchFrontmatterSourceCst}) and the
 * external-edit conflict resolver.
 *
 * History (Phase 6): this module once also held `patchFrontmatterSource`, a
 * byte-splice frontmatter engine that diffed a plain object against a re-parsed
 * source and hand-spliced the changed keys — with TWO YAML parsers in the loop
 * (`js-yaml` for the compare, the `yaml` package for the CST ranges + scalar
 * emit). That dual-parser splice was the root cause of a recurring corruption
 * class (DI-01 unquoted-date→ISO, DI-05 destroyed `<<` merge keys, R1
 * canonicalised untouched scalars, M2 cross-parser `1_000`/`0b1010` drift, C1
 * bare-key collapse). Phase 6 replaced it with the single-parser CST engine in
 * `frontmatterCstModel.ts`, which emits every untouched node from its own source
 * tokens — byte-for-byte, no heuristic — so the class cannot recur. Phase 6.7
 * deleted the legacy engine; only these value helpers it shared remain here.
 */

/**
 * Structural equality for frontmatter values (scalars, arrays, plain objects).
 *
 * 6.4.M3 — the previous `JSON.stringify(a) === JSON.stringify(b)` form was
 * key-order-sensitive for plain objects: a YAML map `{author, date}` on disk
 * compared unequal to an in-memory `{date, author}` even though they're the
 * same data. The unequal verdict tripped a node rewrite that discards the
 * original CST tokens — losing any comments attached to the unchanged keys
 * inside that map. Recursing structurally fixes the comparison without
 * rebuilding the JSON twice.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // 5.1 (Audit-17) — `NaN !== NaN` by IEEE-754, but two `.nan` frontmatter
  // values are the SAME data. Without this an untouched `.nan` key is flagged
  // changed on every unrelated edit: a scalar gets spelling-canonicalised, a
  // collection containing NaN is rebuilt (`rebuildPair`) — permanently dropping
  // that pair's inner comments / flow formatting (an untouched-key byte-
  // preservation violation). Treat NaN as equal to NaN.
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  // DI-01b — a Date is `typeof 'object'` with NO own keys, so the generic
  // object branch below would compare two DIFFERENT Dates as equal (`Object.keys`
  // is `[]` for both) and silently drop a date edit. Compare Dates by instant.
  // Masked today by DI-01 (reads are strings, never Dates), but this forecloses
  // the collision a naive future change could reintroduce.
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
 * DI-01b — coerce a residual `Date` to the plain `YYYY-MM-DD` form so a changed
 * date value never re-emits as a `yaml`-package ISO timestamp. Reads produce
 * strings under the `yaml` core schema (DI-01), so this is defence for a future
 * change that lets a `Date` reach the serializer.
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
 */
export function serializeKeyValue(key: string, value: unknown): string {
  return new Document({ [key]: coerceForEmit(value) }).toString({ lineWidth: 0 });
}
