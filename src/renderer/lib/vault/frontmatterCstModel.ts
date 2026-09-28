import { parseDocument, isAlias, isMap, isScalar, isSeq, Parser, CST, type YAMLMap } from 'yaml';
import { valuesEqual, serializeScalar, serializeKeyValue } from './frontmatterEngine';

/**
 * The source-preserving frontmatter patch engine — CST operations on the `yaml`
 * package. Production routes every frontmatter write through
 * `patchFrontmatterSourceCst` (called from `markdownSync.assembleMarkdownFile`
 * and the three `tagRewriter` writers).
 *
 * The write is expressed as OPERATIONS ON THE `yaml` PACKAGE'S CST: an untouched
 * key is emitted from its own source tokens — byte-for-byte, with no heuristic —
 * so there is no byte-splice arithmetic to get wrong.
 *
 * SINGLE PARSER — the value-comparison object is derived with `doc.toJS()` (the
 * `yaml` package), the SAME parser the read path (`markdownSync.parseMarkdownFile`)
 * uses to produce `nextObj`. Both sides of the diff are on one parser, so an
 * untouched scalar can never look "changed" through a cross-parser type mismatch
 * (e.g. `1_000` / `0b1010`, strings here but numbers to other parsers).
 *
 * WHY THE LOW-LEVEL `Parser`, NOT `doc.contents.srcToken`. Stringifying the
 * block-map's `srcToken` drops the document's LEADING comment (a top-level token
 * emitted BEFORE the document) and its trailing comment (carried on the document
 * token's `end`). Stringifying the whole `Parser` token stream preserves both —
 * verified byte-for-byte against yaml@2.9.0. The block map we mutate is
 * `documentToken.value`.
 *
 * FAILS CLOSED: returns `null` when the source is not a parseable BLOCK mapping
 * (or a touched anchored key risks a dangling alias), so callers fall back to a
 * full dump rather than risk corrupting a block they couldn't model.
 */

type CollectionItem = CST.CollectionItem;

/** The block-map token we mutate, or `null` when there is no mapping to edit. */
function blockMapOf(tokens: CST.Token[]): CST.BlockMap | null {
  for (const t of tokens) {
    if (t.type === 'document' && t.value && t.value.type === 'block-map') return t.value;
  }
  return null;
}

/** Resolved string form of an item's key (`String(key.value)`). */
function itemKeyString(item: CollectionItem): string | null {
  const key = item.key;
  if (!key || !CST.isScalar(key)) return null;
  return String(CST.resolveAsScalar(key).value);
}

/**
 * True for a single-line scalar VALUE token (`scalar` / `single-quoted-scalar` /
 * `double-quoted-scalar` with no embedded newline). A `block-scalar` (`>` / `|`)
 * is multi-line; a `block-seq` / `flow-collection` is a collection; a bare key
 * has a `null` value. All of those route to the whole-pair rebuild. A bare key
 * has no value token here, so it never gets the unsafe value-only splice (which
 * would produce e.g. `aliases:home`).
 */
function isSingleLineScalarValue(value: CST.Token | null | undefined): value is CST.FlowScalar {
  if (!value) return false;
  if (
    value.type !== 'scalar' &&
    value.type !== 'single-quoted-scalar' &&
    value.type !== 'double-quoted-scalar'
  ) {
    return false;
  }
  return value.source.length > 0 && value.source.indexOf('\n') === -1;
}

/** A `FlowScalar` carries a trailing `end` (inline comment + newline); `BlockScalar` does not. */
function isFlowScalar(token: CST.Token | null | undefined): token is CST.FlowScalar {
  return (
    !!token &&
    (token.type === 'scalar' ||
      token.type === 'single-quoted-scalar' ||
      token.type === 'double-quoted-scalar' ||
      token.type === 'alias')
  );
}

/**
 * Does an item's key/sep/value subtree carry a YAML
 * anchor (`&a`, a SourceToken of type `anchor`, in the item's `sep`/`start`), an
 * alias (`*a`, a FlowScalar of type `alias`), or an explicit `!!tag` / `!tag`
 * (a SourceToken of type `tag`, also in `sep`/`start`)? Re-emitting a CHANGED or
 * DELETED such key is unsafe:
 *  - anchor: re-emitting dangles its aliases (js-yaml then throws on re-read,
 *    collapsing the block) — or inlines an alias the object diff already
 *    resolved (silently diverging anchor from alias).
 *  - tag: the value-only splice keeps the `tag` SourceToken while replacing
 *    the value, emitting e.g. `priority: !!int high` — which Filo reads as NaN
 *    and js-yaml-based tools (Obsidian) reject. A touched tagged key goes to
 *    the full-dump fallback (structure expanded, data exact).
 * Recurses nested collections so a `widget:\n  <<: *base` alias is found on
 * `widget` even though the alias is nested. An anchor/alias/tag confined to
 * UNTOUCHED keys is spliced verbatim and stays valid (`<<: *base` survives a
 * tag-add; an untouched `!!int 5` stays byte-exact).
 */
function tokenHasAnchorAliasOrTag(token: CST.Token | null | undefined): boolean {
  if (!token) return false;
  if (token.type === 'alias' || token.type === 'anchor') return true;
  if (CST.isCollection(token)) {
    for (const item of token.items) if (itemHasAnchorAliasOrTag(item)) return true;
  }
  return false;
}

/** True when any SourceToken in the list is an anchor (`&a`) or an explicit tag (`!!t` / `!t`). */
function sourceTokensHaveAnchorOrTag(tokens: CST.SourceToken[] | undefined): boolean {
  return !!tokens && tokens.some((t) => t.type === 'anchor' || t.type === 'tag');
}

function itemHasAnchorAliasOrTag(item: CollectionItem): boolean {
  return (
    sourceTokensHaveAnchorOrTag(item.start) ||
    tokenHasAnchorAliasOrTag(item.key) ||
    sourceTokensHaveAnchorOrTag(item.sep) ||
    tokenHasAnchorAliasOrTag(item.value)
  );
}

/**
 * Rewrites a changed single-line scalar VALUE while keeping its `key:` prefix,
 * indentation, AND same-line trailing comment. The new scalar text comes from
 * {@link serializeScalar} (NOT `CST.setScalarValue`, which keeps the old plain
 * style and would emit the string `"123"` as bare `123` → re-parses as a number,
 * corrupting the type). We parse `k: <text>` to get a correctly-quoted value
 * token, then transplant the ORIGINAL value's trailing `end` tokens (the inline
 * comment + line newline) so they survive byte-for-byte.
 */
function setScalarKeepingComment(item: CollectionItem, value: unknown): void {
  const text = serializeScalar(value);
  const probe = blockMapOf([...new Parser().parse(`k: ${text}\n`)]);
  const probeValue = probe?.items[0]?.value;
  if (!probeValue) return;
  if (isFlowScalar(probeValue) && isFlowScalar(item.value)) {
    probeValue.end = item.value.end;
  }
  item.value = probeValue;
}

/**
 * Rebuilds a changed COLLECTION / scalar↔collection type change / bare-key set:
 * re-serialises the whole `key: value` pair via {@link serializeKeyValue} and
 * swaps the item's key/sep/value, KEEPING its `start` (so a standalone comment
 * ABOVE the pair survives — the leading-gap is never re-emitted). A same-line
 * trailing comment / inner nested comment is dropped here (see KNOWN_LIMITATIONS #1).
 * The rebuilt pair always carries a trailing newline; the final trailing-newline
 * trim reconciles the last-line-without-newline case.
 */
function rebuildPair(item: CollectionItem, key: string, value: unknown): void {
  const built = blockMapOf([...new Parser().parse(serializeKeyValue(key, value))])?.items[0];
  if (!built) return;
  item.key = built.key;
  item.sep = built.sep;
  item.value = built.value;
}

/**
 * Split a DELETED key's leading `start` tokens into the structural gap to
 * keep (blank lines / key indentation) versus the standalone comment lines to
 * drop. A comment immediately above a key conventionally documents THAT key, so
 * when the key is deleted its comment must go with it rather than relocate onto
 * the next surviving key — where it would mis-document an unrelated field — or
 * dangle at the document end. We group the tokens into source lines and keep a
 * line only when it carries no `comment` token, so inter-key blank-line spacing
 * survives the delete while the comment (and its own line terminator) does not.
 * Applied ONLY to a deleted item's `start`; a surviving key's comments are never
 * touched. (A leading top-level comment before the first key lives in the
 * document's own token, not in any item's `start`, so it is unaffected here.)
 */
function gapWithoutCommentLines(tokens: CST.SourceToken[]): CST.SourceToken[] {
  const kept: CST.SourceToken[] = [];
  let line: CST.SourceToken[] = [];
  let lineHasComment = false;
  const flushLine = (): void => {
    if (!lineHasComment) for (const t of line) kept.push(t);
    line = [];
    lineHasComment = false;
  };
  for (const token of tokens) {
    line.push(token);
    if (token.type === 'comment') lineHasComment = true;
    if (token.type === 'newline') flushLine();
  }
  flushLine(); // trailing partial line (key indentation, no newline) — kept if comment-free
  return kept;
}

/**
 * Patches `originalSource`'s frontmatter to `nextObj`'s values via CST operations
 * — the source-preserving frontmatter patch engine. Untouched
 * keys keep their exact bytes; a changed single-line scalar is rewritten
 * value-only; collections / type-changes / bare-key sets / added keys are
 * re-serialised; deleted keys are spliced out (keeping the blank-line gap above
 * them but dropping a comment that documented the deleted key, so it never
 * mis-documents the next survivor). Output is LF with no trailing newline (the
 * caller re-wraps fences and re-applies the file's own line ending).
 *
 * Returns `null` (caller falls back to a full dump) when the source is not a
 * parseable single BLOCK mapping, or when a changed/deleted key carries an
 * anchor/alias or an explicit YAML tag.
 */
export function patchFrontmatterSourceCst(
  originalSource: string,
  nextObj: Record<string, unknown>,
): string | null {
  // Normalise to LF before tokenising (a dirty FM write always emits an LF
  // block; the caller re-applies the file's own ending).
  const source = originalSource.replace(/\r\n/g, '\n');

  // GATE — refuse on fatal errors, non-map root, flow-map root.
  let doc;
  try {
    doc = parseDocument(source, { uniqueKeys: true, logLevel: 'error' });
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;
  const root = doc.contents;
  if (root !== null) {
    if (!isMap(root)) return null;
    if (root.flow === true) return null;
  }

  // Value-comparison object — derived with `doc.toJS()`, the SAME parser the
  // read path used to build `nextObj`, so an untouched scalar is never seen as
  // "changed" through a cross-parser type mismatch.
  let currentObj: Record<string, unknown>;
  if (root === null) {
    currentObj = {};
  } else {
    // `parseDocument` reports no errors for a dangling alias (`*x` with no
    // `&x`) or missing-anchor `<<` merge, but `toJS()` THROWS resolving it.
    // Fail closed to `null` so the caller keeps the raw bytes verbatim (the read
    // path returned `{}` for this block, so a full dump would erase it).
    let current: unknown;
    try {
      current = doc.toJS();
    } catch {
      return null;
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
    currentObj = current as Record<string, unknown>;
  }

  // CST token stream for the surgical edits (the mutable model).
  const tokens = [...new Parser().parse(source)];
  const documentTokens = tokens.filter((t): t is CST.Document => t.type === 'document');
  // A multi-document block can't arise via the fence regex (a column-0 `---`
  // would have been the closing fence), but refuse defensively rather than edit
  // only the first document.
  if (documentTokens.length > 1) return null;
  const documentToken = documentTokens[0] ?? null;
  const mapToken = blockMapOf(tokens);
  // A non-flow block mapping per parseDocument must surface as a block-map here.
  if (root !== null && mapToken === null) return null;

  const presentKeys = new Set<string>();

  if (mapToken) {
    // Refuse a mapping carrying a NON-SCALAR key (`[a, b]: x`, `{k: 1}: x`,
    // explicit-key `? …`, an empty key). `toJS()` STRINGIFIES such keys, so the
    // added-keys pass below would append the stringified twin as a NEW string
    // key — a silent semantic duplicate. Fail closed.
    for (const item of mapToken.items) {
      if (itemKeyString(item) === null) return null;
    }

    // Pass 1 — anchor/alias/tag guard. Refuse before mutating anything
    // if any changed/deleted key's subtree carries an anchor, alias, or explicit
    // YAML tag.
    for (const item of mapToken.items) {
      const key = itemKeyString(item);
      if (key === null) continue;
      const deleted = !(key in nextObj) || nextObj[key] === undefined;
      const changed = !deleted && !valuesEqual(currentObj[key], nextObj[key]);
      if ((deleted || changed) && itemHasAnchorAliasOrTag(item)) return null;
    }

    // Pass 2 — apply. Build the surviving-items array so a deleted item's leading
    // BLANK LINES (`start`) relocate to the next survivor (or, when the deleted
    // key is trailing, onto the document end) — preserving inter-key spacing. A
    // comment glued to the deleted key is dropped with it (relocating it would
    // mis-document the next survivor); a surviving key's comments are kept.
    const nextItems: CST.BlockMap['items'] = [];
    let pendingStart: CST.SourceToken[] = [];
    for (const item of mapToken.items) {
      const key = itemKeyString(item);
      if (key === null) {
        nextItems.push(item);
        continue;
      }
      presentKeys.add(key);

      const deleted = !(key in nextObj) || nextObj[key] === undefined;
      if (deleted) {
        // Keep the structural gap (blank lines) above the deleted key but DROP a
        // comment glued to it (see `gapWithoutCommentLines`).
        pendingStart = pendingStart.concat(gapWithoutCommentLines(item.start));
        continue;
      }

      if (pendingStart.length > 0) {
        item.start = pendingStart.concat(item.start);
        pendingStart = [];
      }

      const nextValue = nextObj[key];
      if (valuesEqual(currentObj[key], nextValue)) {
        nextItems.push(item); // unchanged → byte-preserved by CST.stringify
        continue;
      }

      const nextIsPrimitive = nextValue === null || typeof nextValue !== 'object';
      if (
        isSingleLineScalarValue(item.value) &&
        nextIsPrimitive &&
        serializeScalar(nextValue).indexOf('\n') === -1
      ) {
        setScalarKeepingComment(item, nextValue);
      } else {
        rebuildPair(item, key, nextValue);
      }
      nextItems.push(item);
    }

    mapToken.items = nextItems;

    // A trailing deleted key's relocated comments attach to the document end, in
    // source order (prepended before any pre-existing trailing comment).
    if (pendingStart.length > 0 && documentToken) {
      documentToken.end = pendingStart.concat(documentToken.end ?? []);
    }
  }

  let result = tokens.map((t) => CST.stringify(t)).join('');

  // Append keys present in nextObj but absent from the source, in nextObj order.
  // Added keys have no source to preserve, so a serialised text append is
  // byte-equivalent to a CST item build, and it sidesteps the CST
  // append-without-newline concatenation wrinkle (`count: 3newkey`).
  const addedKeys = Object.keys(nextObj).filter(
    (key) => !presentKeys.has(key) && nextObj[key] !== undefined,
  );
  if (addedKeys.length > 0) {
    if (result.length > 0 && !result.endsWith('\n')) result += '\n';
    for (const key of addedKeys) result += serializeKeyValue(key, nextObj[key]);
  }

  return result.replace(/\r?\n$/, '');
}

/**
 * Does `source` parse as valid YAML at all (no fatal parser errors)? Used by
 * the assemble path to tell apart the TWO reasons
 * {@link patchFrontmatterSourceCst} returns `null` for a PRESENT block, which
 * need OPPOSITE handling:
 *  - `false` → genuinely UNPARSEABLE (tabs, duplicate keys, a stray `---`). A
 *    full dump would DISCARD the broken-but-present block entirely, so the
 *    caller keeps the raw bytes instead.
 *  - `true` → valid YAML. The engine refused for a reason where the dump may
 *    be DATA-PRESERVING (flow-mapping root, anchor/alias expansion, dropped
 *    `!!tag`), but a valid block whose root is NOT a mapping (a scalar such as
 *    a paragraph between two leading `---` rules, a sequence, only comments)
 *    would be replaced wholesale by a dump of the delta keys, so the caller
 *    also checks {@link frontmatterSourceRootIsMapping}.
 *
 * `errors.length === 0` is not sufficient: a dangling alias / missing-anchor
 * `<<` merge parses cleanly yet THROWS in `toJS()`. We force the resolution
 * here so such a block reports `false` (keep-raw).
 */
export function frontmatterSourceParses(source: string): boolean {
  try {
    const doc = parseDocument(source.replace(/\r\n/g, '\n'), { uniqueKeys: true, logLevel: 'error' });
    if (doc.errors.length > 0) return false;
    // Resolve aliases/merges — throws on a dangling reference; the catch
    // below maps that to `false` so the assemble path keeps the raw bytes.
    doc.toJS();
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `source` parses and its root is a mapping (block or flow). Any
 * other root holds text that isn't properties, which a dump of the delta keys
 * would delete, so the assemble path keeps such a block verbatim and refuses
 * the metadata edit.
 */
export function frontmatterSourceRootIsMapping(source: string): boolean {
  try {
    const doc = parseDocument(source.replace(/\r\n/g, '\n'), { uniqueKeys: true, logLevel: 'error' });
    return doc.errors.length === 0 && isMap(doc.contents);
  } catch {
    return false;
  }
}

/**
 * The set of top-level keys in a
 * frontmatter source, or an empty set when the source is absent / unparseable.
 *
 * The assemble path consults this before its null/undefined clean pass: a
 * present-but-empty key on disk (`aliases:`, `cssclasses:`) parses to `null`,
 * and stripping it from the live object would make {@link patchFrontmatterSourceCst}
 * see it as DELETED and splice the line out — silently erasing a key the user
 * kept, on any unrelated metadata edit. A key in this set is preserved as the
 * empty value it already holds on disk.
 */
export function frontmatterSourceKeys(source: string): Set<string> {
  try {
    const doc = parseDocument(source.replace(/\r\n/g, '\n'), { uniqueKeys: true, logLevel: 'error' });
    if (doc.errors.length === 0) {
      const obj = doc.toJS();
      if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
        return new Set(Object.keys(obj as Record<string, unknown>));
      }
    }
  } catch {
    /* unparseable — no keys to preserve */
  }
  return new Set();
}

/**
 * True when the source's top-level block mapping carries an
 * item whose KEY is not a single scalar (`[a, b]: x`, `{k: 1}: x`, an
 * explicit-key `? …` form, an empty key). For such a source the OBJECT view is
 * not faithful: `toJS()` stringifies the key ("[ a, b ]") because a plain JS
 * object can't hold it, so a full dump from that object would rewrite the key
 * as its quoted STRING twin — a semantic change, not a reformat. The assemble
 * path uses this to route the engine's refusal to keep-raw (refuse the metadata
 * edit, preserve the block byte-for-byte) instead of the dump fallback, which
 * is reserved for refusals where the dump is data-preserving.
 */
export function frontmatterSourceHasNonScalarKey(source: string): boolean {
  try {
    const tokens = [...new Parser().parse(source.replace(/\r\n/g, '\n'))];
    const mapToken = blockMapOf(tokens);
    if (!mapToken) return false;
    for (const item of mapToken.items) {
      if (itemKeyString(item) === null) return true;
    }
  } catch {
    /* tokeniser failure — not this helper's concern (the parse gate refuses) */
  }
  return false;
}

/**
 * Why a metadata edit of a note with this frontmatter source can't land, or
 * null when it can (no block, an empty one, or YAML that parses to a mapping
 * with plain keys). The assembler keeps any other block verbatim and refuses
 * the edit for the same reasons, so a view can say so before it queues an
 * edit (and an undo step) that would do nothing.
 */
export function frontmatterSourceProblem(source: string): 'unparseable' | 'not-properties' | null {
  if (!source.trim()) return null;
  if (!frontmatterSourceParses(source)) return 'unparseable';
  if (!frontmatterSourceRootIsMapping(source)) return 'not-properties';
  return frontmatterSourceHasNonScalarKey(source) ? 'unparseable' : null;
}

type YamlDoc = ReturnType<typeof parseDocument>;

/** `node` with an alias followed to the node it names (null when it names none). */
function resolved(node: unknown, doc: YamlDoc): unknown {
  if (!isAlias(node)) return node;
  try {
    return node.resolve(doc) ?? null;
  } catch {
    return null;
  }
}

/** The value node of `key` in `map`, following `<<` merges as `toJS()` does. */
function valueNodeOf(map: YAMLMap, key: string, doc: YamlDoc, depth = 0): unknown {
  let merged: unknown;
  for (const pair of map.items) {
    const k = isScalar(pair.key) ? String(pair.key.value) : null;
    if (k === key) return pair.value;
    if (k === '<<' && merged === undefined && depth < 8) {
      const sources = resolved(pair.value, doc);
      const list = isSeq(sources) ? sources.items.map((i) => resolved(i, doc)) : [sources];
      for (const source of list) {
        if (!isMap(source)) continue;
        const found = valueNodeOf(source, key, doc, depth + 1);
        if (found !== undefined) {
          merged = found;
          break;
        }
      }
    }
  }
  return merged;
}

/**
 * True when the dump's node says what the source's node said. A scalar keeps
 * its value's text (`02134`, `1.10` and `0xFF00FF` read as numbers, and a dump
 * would write `2134`, `1.1` and `16711935`); a string may change its quoting,
 * a null its spelling (`~`). An explicit tag must survive. Collections compare
 * item by item.
 */
function sameNode(src: unknown, srcDoc: YamlDoc, out: unknown, outDoc: YamlDoc, depth = 0): boolean {
  if (depth > 32) return false;
  const a = resolved(src, srcDoc);
  const b = resolved(out, outDoc);
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (isScalar(a) && isScalar(b)) {
    if (a.tag !== undefined && a.tag !== b.tag) return false;
    if (a.value === null && b.value === null) return true;
    if (typeof a.value === 'string') return typeof b.value === 'string' && a.value === b.value;
    const text = (n: typeof a): string => (typeof n.source === 'string' ? n.source : String(n.value));
    return text(a) === text(b);
  }
  if (isSeq(a) && isSeq(b)) {
    if (a.tag !== undefined && a.tag !== b.tag) return false;
    return a.items.length === b.items.length && a.items.every((item, i) => sameNode(item, srcDoc, b.items[i], outDoc, depth + 1));
  }
  if (isMap(a) && isMap(b)) {
    if (a.tag !== undefined && a.tag !== b.tag) return false;
    const keys = (m: YAMLMap): string[] => m.items.map((p) => (isScalar(p.key) ? String(p.key.value) : '')).filter((k) => k !== '' && k !== '<<');
    const srcKeys = new Set(keys(a));
    for (const key of srcKeys) {
      if (!sameNode(valueNodeOf(a, key, srcDoc), srcDoc, valueNodeOf(b, key, outDoc), outDoc, depth + 1)) return false;
    }
    return true;
  }
  return false;
}

/**
 * True when a full dump of `nextObj` (the fallback for a block the patch
 * engine refuses) still says, for every key the change didn't touch, what the
 * source said. `nextObj` is the core-schema JS value, so a dump rewrites values
 * whose text isn't their canonical form (`02134` → `2134`, `1.10` → `1.1`,
 * `0xFF00FF` → `16711935`) and drops explicit tags. A false answer means the
 * edit must be refused and the block kept as it is.
 */
export function dumpPreservesUntouched(sourceFm: string, dumped: string, nextObj: Record<string, unknown>): boolean {
  let srcDoc: YamlDoc;
  let outDoc: YamlDoc;
  let current: unknown;
  try {
    srcDoc = parseDocument(sourceFm.replace(/\r\n/g, '\n'), { uniqueKeys: true, logLevel: 'error' });
    outDoc = parseDocument(dumped, { uniqueKeys: true, logLevel: 'error' });
    if (srcDoc.errors.length > 0 || outDoc.errors.length > 0) return false;
    current = srcDoc.toJS();
  } catch {
    return false;
  }
  const srcRoot = srcDoc.contents;
  const outRoot = outDoc.contents;
  if (srcRoot === null) return true;
  if (!isMap(srcRoot) || !isMap(outRoot)) return false;
  if (current === null || typeof current !== 'object' || Array.isArray(current)) return false;
  for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
    // A key the change set or removed is the change itself.
    if (!(key in nextObj) || !valuesEqual(value, nextObj[key])) continue;
    if (!sameNode(valueNodeOf(srcRoot, key, srcDoc), srcDoc, valueNodeOf(outRoot, key, outDoc), outDoc)) return false;
  }
  return true;
}
