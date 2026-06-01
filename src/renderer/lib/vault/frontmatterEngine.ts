import { parseDocument, isMap } from 'yaml';

/**
 * Audit2 4.8 — the single source-preserving frontmatter serializer.
 *
 * Filo's frontmatter write paths historically had two seams:
 *  - `markdownSync.assembleMarkdownFile` re-`js-yaml.dump`ed the whole object on
 *    every metadata change, discarding comments / key order / quoting (the
 *    documented "lossy YAML round-trip" KNOWN_LIMITATION #1), and
 *  - `tagRewriter` hand-rolled a line-level editor for tags, but fell back to
 *    that same lossy `dump` for shapes its matchers declined.
 *
 * This module replaces the lossy `dump` in BOTH with the `yaml` package's
 * Document/CST API: it parses the ORIGINAL frontmatter source, applies only the
 * keys that actually changed, and re-serialises — so comments, key order,
 * quoting, and indentation on every UNTOUCHED key survive. The hand-rolled tag
 * line-editor stays as `tagRewriter`'s fast path; this is the (now lossless)
 * fallback both paths share, so there is no longer a lossy seam to fall into.
 *
 * Fails closed: returns `null` when the original source can't be parsed into a
 * mapping, so callers refuse the write rather than risk corrupting a block they
 * couldn't understand (mirrors the existing `loadYamlObject(...) → null` guard).
 */

/**
 * Structural equality for frontmatter values (scalars, arrays, plain objects).
 *
 * 6.4.M3 — the previous `JSON.stringify(a) === JSON.stringify(b)` form was
 * key-order-sensitive for plain objects: a YAML map `{author, date}` on disk
 * compared unequal to an in-memory `{date, author}` even though they're the
 * same data. The unequal verdict tripped a `doc.set(key, value)` rewrite of
 * the entire node, which discards the original CST tokens — losing any
 * comments attached to the unchanged keys inside that map. Recursing
 * structurally fixes the comparison without rebuilding the JSON twice.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
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
 * Re-serialises `originalSource`'s frontmatter with `nextObj`'s values, touching
 * only the keys whose value actually changed (and deleting keys absent from
 * `nextObj`). Every untouched key keeps its original bytes — comments, ordering,
 * quote style, indentation. Output is LF with no trailing newline (the caller
 * re-wraps fences and re-applies the file's own line ending).
 *
 * Returns `null` when `originalSource` is not a parseable YAML mapping — the
 * caller must then refuse the write (never silently drop an unparseable block).
 */
export function patchFrontmatterSource(
  originalSource: string,
  nextObj: Record<string, unknown>,
): string | null {
  let doc;
  try {
    doc = parseDocument(originalSource, { uniqueKeys: true });
  } catch {
    return null;
  }
  // Fatal parse errors (e.g. duplicate keys, bad indentation) → refuse.
  if (doc.errors.length > 0) return null;

  const root = doc.contents;
  // A blank source parses to a null root — we can grow a mapping onto it.
  // A top-level scalar or sequence is NOT a frontmatter mapping → refuse.
  if (root !== null && !isMap(root)) return null;

  const current = (root === null ? {} : doc.toJS()) as unknown;
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    return null;
  }
  const currentObj = current as Record<string, unknown>;

  // Delete keys the caller dropped.
  for (const key of Object.keys(currentObj)) {
    if (!(key in nextObj)) doc.delete(key);
  }
  // Set changed / added keys; leave unchanged keys' nodes (and their comments)
  // exactly as parsed.
  for (const [key, value] of Object.entries(nextObj)) {
    if (value === undefined) continue;
    if (!valuesEqual(currentObj[key], value)) {
      doc.set(key, value);
    }
  }

  // lineWidth: 0 disables line folding (mirrors js-yaml `lineWidth: -1`) so a
  // long value is never wrapped into a multi-line scalar.
  return doc.toString({ lineWidth: 0 }).replace(/\r?\n$/, '');
}
