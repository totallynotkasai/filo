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
 * Patches `originalSource`'s frontmatter to `nextObj`'s values via CST operations
 * — the source-preserving frontmatter patch engine. Untouched
 * keys keep their exact bytes; a changed single-line scalar is rewritten
 * value-only; collections / type-changes / bare-key sets / added keys are
 * re-serialised; deleted keys are spliced out (relocating any standalone comment
 * above them so it is never silently dropped). Output is LF with no trailing
 * newline (the caller re-wraps fences and re-applies the file's own line ending).
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
    const current = doc.toJS();
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
    // comments/blank lines (`start`) relocate to the next survivor (or, when the
    // deleted key is trailing, onto the document end) instead of vanishing —
    // matching the legacy engine, which always emits the inter-key gap verbatim.
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
        pendingStart = pendingStart.concat(item.start);
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
