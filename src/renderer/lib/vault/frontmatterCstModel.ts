import { parseDocument, isMap, Parser, CST } from 'yaml';
import { valuesEqual, serializeScalar, serializeKeyValue } from './frontmatterEngine';

/**
 * The source-preserving frontmatter patch engine — CST operations on the `yaml`
 * package. Production routes every frontmatter write through
 * `patchFrontmatterSourceCst` (called from `markdownSync.assembleMarkdownFile`
 * and the three `tagRewriter` writers).
 *
 * WHY this engine exists. Six audits patched the same bug class: frontmatter was
 * written by diffing a plain object against a re-parsed source and then
 * hand-splicing bytes for the changed keys — with TWO YAML parsers in the loop
 * (js-yaml for the compare, the `yaml` package for the CST ranges + scalar emit).
 * Every recurring corruption (DI-01, DI-05, R1, M2, C1, L23, L27, L28, DI-06) was
 * a leak in that machine. This engine expresses the write as OPERATIONS ON THE
 * `yaml` PACKAGE'S CST instead: an untouched key is emitted from its own source
 * tokens — byte-for-byte, with no heuristic — so there is no splice arithmetic to
 * get wrong and no second parser to disagree with. Phase 6 built it alongside the
 * legacy byte-splice engine, proved it equivalent across the whole corpus + a
 * fuzzer, routed production through it (6.2–6.6), then 6.7 deleted the legacy
 * splice and its dual-parser scaffolding — so the bug class is gone, not guarded.
 *
 * SINGLE PARSER — the value-comparison object is derived with `doc.toJS()` (the
 * `yaml` package), the SAME parser the read path (`markdownSync.parseMarkdownFile`)
 * uses to produce `nextObj`. Both sides of the diff are on one parser, so an
 * untouched scalar can never look "changed" through a cross-parser type mismatch —
 * the M2 class (`1_000` / `0b1010` are STRINGS to the `yaml` package but NUMBERS to
 * js-yaml CORE) is structurally dead.
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

/** Resolved string form of an item's key, matching the legacy `String(key.value)`. */
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
 * has no value token here, so it can never look like a single-line scalar and
 * never gets the unsafe value-only splice that produced `aliases:home` in C1.
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
 * L27 — does an item's key/sep/value subtree carry a YAML anchor (`&a`, a
 * SourceToken of type `anchor`, which sits in the item's `sep`/`start`) or an
 * alias (`*a`, a FlowScalar of type `alias`)? Re-emitting a CHANGED or DELETED
 * anchored key would dangle its aliases (js-yaml then throws on re-read,
 * collapsing the block) or inline an alias the object diff already resolved
 * (silently diverging anchor from alias). Recurses nested collections so a
 * `widget:\n  <<: *base` alias is found on `widget` even though the alias is
 * nested. An anchor/alias confined to UNTOUCHED keys is spliced verbatim and
 * stays valid (DI-05's `<<: *base` survives a tag-add).
 */
function tokenHasAnchorOrAlias(token: CST.Token | null | undefined): boolean {
  if (!token) return false;
  if (token.type === 'alias' || token.type === 'anchor') return true;
  if (CST.isCollection(token)) {
    for (const item of token.items) if (itemHasAnchorOrAlias(item)) return true;
  }
  return false;
}

function sourceTokensHaveAnchor(tokens: CST.SourceToken[] | undefined): boolean {
  return !!tokens && tokens.some((t) => t.type === 'anchor');
}

function itemHasAnchorOrAlias(item: CollectionItem): boolean {
  return (
    sourceTokensHaveAnchor(item.start) ||
    tokenHasAnchorOrAlias(item.key) ||
    sourceTokensHaveAnchor(item.sep) ||
    tokenHasAnchorOrAlias(item.value)
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
 * trailing comment / inner nested comment is dropped here (documented L23 / L28).
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
 * L4 — split a DELETED key's leading `start` tokens into the structural gap to
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
 * them but dropping a comment that documented the deleted key — L4 — so it never
 * mis-documents the next survivor). Output is LF with no trailing newline (the
 * caller re-wraps fences and re-applies the file's own line ending).
 *
 * Returns `null` (caller falls back to a full dump) when the source is not a
 * parseable single BLOCK mapping, or when a changed/deleted key carries an
 * anchor/alias (L27).
 */
export function patchFrontmatterSourceCst(
  originalSource: string,
  nextObj: Record<string, unknown>,
): string | null {
  // Normalise to LF before tokenising (parity with the legacy engine: a dirty FM
  // write always emits an LF block; the caller re-applies the file's own ending).
  const source = originalSource.replace(/\r\n/g, '\n');

  // GATE — parseDocument gives the exact refusal set of the legacy engine (fatal
  // errors, non-map root, flow-map root).
  let doc;
  try {
    doc = parseDocument(source, { uniqueKeys: true });
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;
  const root = doc.contents;
  if (root !== null) {
    if (!isMap(root)) return null;
    if (root.flow === true) return null;
  }

  // Value-comparison object (Phase 6.3) — derived with `doc.toJS()`, the SAME
  // `yaml`-package parse the read path (`parseMarkdownFile`) used to build
  // `nextObj`. One parser on both sides of the diff means an untouched scalar is
  // never seen as "changed" through a cross-parser type mismatch (the M2 class).
  let currentObj: Record<string, unknown>;
  if (root === null) {
    currentObj = {};
  } else {
    // H2 (Audit-13) — `parseDocument` reports `errors.length === 0` for an
    // unresolved/forward alias (`*x` with no prior `&x`), a missing-anchor `<<`
    // merge, or an alias-in-sequence, but RESOLVING the dangling reference in
    // `toJS()` then THROWS a ReferenceError. That throw is OUTSIDE the refusal
    // gate above, so without this catch it propagates out of the engine →
    // `assembleMarkdownFile` → the write, bypassing the keep-raw safety net
    // built for malformed YAML (the read path already returned `{}` for the same
    // block, so a fall-through full dump would ERASE it — total FM loss). Fail
    // closed to `null` (the documented refusal contract) so the caller keeps the
    // raw bytes verbatim and only the metadata edit is dropped.
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
    // 5.4 (Audit-16) — refuse a mapping carrying a NON-SCALAR key (`[a, b]: x`,
    // `{k: 1}: x`, an explicit-key `? …` form, an empty key). `toJS()`
    // STRINGIFIES such keys ("[ a, b ]") because a plain JS object can't hold
    // them, so `currentObj`/`nextObj` are NOT faithful views of the source: the
    // item can't be matched to an object key (`itemKeyString` → null) and the
    // added-keys pass below would emit the stringified twin as a NEW string key
    // — a silent semantic duplicate (`[a, b]: x` + `"[ a, b ]": x`) appended by
    // any unrelated edit. Mirror the multi-document and anchor refusals: fail
    // closed and let the caller's keep-raw/dump decision handle it.
    for (const item of mapToken.items) {
      if (itemKeyString(item) === null) return null;
    }

    // Pass 1 — L27 anchor guard. Refuse before mutating anything if any
    // changed/deleted key's subtree carries an anchor/alias.
    for (const item of mapToken.items) {
      const key = itemKeyString(item);
      if (key === null) continue;
      const deleted = !(key in nextObj) || nextObj[key] === undefined;
      const changed = !deleted && !valuesEqual(currentObj[key], nextObj[key]);
      if ((deleted || changed) && itemHasAnchorOrAlias(item)) return null;
    }

    // Pass 2 — apply. Build the surviving-items array so a deleted item's leading
    // BLANK LINES (`start`) relocate to the next survivor (or, when the deleted
    // key is trailing, onto the document end) — preserving inter-key spacing. A
    // comment glued to the deleted key is dropped with it (L4: relocating it
    // would mis-document the next survivor); a surviving key's comments are kept.
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
        // L4 — keep the structural gap (blank lines) above the deleted key but
        // DROP a comment glued to it, so its documenting comment is removed with
        // the key instead of relocating onto the next survivor (mis-documenting
        // an unrelated field).
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
 * 1.5 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — does `source` parse as valid
 * YAML at all (no fatal parser errors)? Used by the assemble path to tell apart
 * the TWO reasons {@link patchFrontmatterSourceCst} returns `null` for a PRESENT
 * block, which need OPPOSITE handling:
 *  - returns `false` here → the source is genuinely UNPARSEABLE (tabs, duplicate
 *    keys, a stray `---`). A full dump of the live object would DISCARD the
 *    broken-but-present block entirely — total frontmatter loss (Finding #4). The
 *    caller keeps the raw bytes instead.
 *  - returns `true` here → the source is valid YAML; the engine refused for a
 *    reason where the dump is DATA-PRESERVING (a flow-mapping root reformats to a
 *    block mapping; a changed/deleted key carrying an anchor/alias expands its
 *    aliases — L27) or replaces a non-mapping root the app never treated as
 *    metadata (a top-level sequence/scalar). The caller's full dump must proceed.
 *
 * Narrow by design: only a parse FAILURE — where dump = unrecoverable loss —
 * trips the caller's refuse-and-keep-raw path. Valid-but-non-mapping YAML keeps
 * the long-standing dump fallback (and its pinning test).
 *
 * H2 (Audit-13) — `errors.length === 0` is necessary but NOT sufficient: an
 * unresolved/forward alias or a missing-anchor `<<` merge parses with zero
 * errors yet THROWS in `toJS()` while resolving the dangling reference. Such a
 * block is "unparseable" for our purposes too — the read path returned `{}` for
 * it, so a full dump would discard it (= the loss case). We force the resolution
 * here (the `toJS()` call) so it reports `false`, routing the caller to keep-raw.
 */
export function frontmatterSourceParses(source: string): boolean {
  try {
    const doc = parseDocument(source.replace(/\r\n/g, '\n'), { uniqueKeys: true });
    if (doc.errors.length > 0) return false;
    // Resolve aliases/merges — throws on a dangling reference (H2); the catch
    // below maps that to `false` so the assemble path keeps the raw bytes.
    doc.toJS();
    return true;
  } catch {
    return false;
  }
}

/**
 * 1.1 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — the set of top-level keys in a
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
    const doc = parseDocument(source.replace(/\r\n/g, '\n'), { uniqueKeys: true });
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
 * 5.4 (Audit-16) — true when the source's top-level block mapping carries an
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
