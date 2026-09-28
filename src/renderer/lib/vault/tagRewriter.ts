import { Document, parseDocument, isSeq } from 'yaml';
import { parseTagsField } from '../utils/normalizeTagsField';
import { patchFrontmatterSourceCst, frontmatterSourceHasNonScalarKey, dumpPreservesUntouched } from './frontmatterCstModel';
import { frontmatterLineEnding } from '../utils/lineEnding';
import { splitFrontmatterFence } from '../notes/frontmatterFence';

/**
 * Frontmatter-only tag rewriter.
 *
 * Filo treats a `.md` file's YAML `tags:` list as the canonical tag source.
 * Inline `#foo` runs in the body are styled via the TipTap mark but carry no
 * tagging semantics, so we never edit body text here. Each function returns
 * a string byte-identical to its input when no frontmatter rewrites happened,
 * letting callers short-circuit the write.
 *
 * The preferred path is a line-level rewrite that touches ONLY the `tags:`
 * field, leaving every other YAML line (comments, anchors, custom fields)
 * byte-identical. The load → source-preserving patch fallback handles shapes
 * the line rewriter can't safely express (nested blocks, unusual whitespace).
 *
 * Everything here (load, last-resort dump, per-tag quoting) uses the `yaml`
 * package — the same parser as the read path and the CST write engine — so
 * the two can't disagree on a scalar and trigger a phantom rewrite.
 */

/**
 * Case-insensitive tag-identity equality. Folds via
 * `toLocaleLowerCase('en-US')` to match the canonical identity used
 * everywhere else: `canonicaliseTagName` (tagsStorage), `vaultIndex.filesByTag`,
 * and `frontmatterSync.valuesEqual`. Pinned to en-US so identity is portable
 * across hosts (a Turkish locale's dotless-i fold would otherwise split
 * `Important` / `important`). The rewriter uses this for its PRESENCE checks
 * only — it still writes the new name and the leading-`#` decision exactly as
 * the caller / the matched token spelled them.
 */
export function tagsEqual(a: string, b: string): boolean {
  return a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US');
}

/**
 * Collapses tag-equal entries (case-insensitive, ignoring a
 * leading `#`), keeping the FIRST occurrence's exact form. Applied after a
 * rename so a merge-rename — `draft`→`review` on a file that already carries
 * `review` — yields `[review]`, not `[review, review]`. A non-merge rename
 * has no duplicates, so this is a no-op for the common case.
 */
function dedupeTags(tags: string[]): string[] {
  const seenBare: string[] = [];
  const out: string[] = [];
  for (const t of tags) {
    const bare = t.replace(/^#/, '');
    if (seenBare.some((s) => tagsEqual(s, bare))) continue;
    seenBare.push(bare);
    out.push(t);
  }
  return out;
}

/** A note split for a frontmatter rewrite: everything but the YAML is re-emitted verbatim. */
interface SplitNote {
  yamlSource: string;
  body: string;
  hasFrontmatter: boolean;
  /** The ending the frontmatter block's lines get (the note writer's rule). */
  eol: '\r\n' | '\n';
  hadBom: boolean;
  /** The file's own fence lines; null when it has no block yet. */
  fences: { open: string; close: string; closeEnd: string } | null;
}

function splitFrontmatter(raw: string): SplitNote {
  // The one fence parser the note writer uses, so a tag rewrite and a note
  // write always agree on where the block ends. It skips a leading BOM
  // (otherwise a BOM file reads as "no frontmatter" and addTagToMarkdown
  // prepends a second block); `hadBom` is re-emitted by `reassemble`. The fence
  // lines (with any trailing whitespace) and the closing fence's line break
  // come back as written so a rewrite re-emits them exactly.
  const { hadBom, block, body } = splitFrontmatterFence(raw);
  const eol = frontmatterLineEnding(raw);
  if (!block) {
    return { yamlSource: '', body, hasFrontmatter: false, eol, hadBom, fences: null };
  }
  // Normalise the captured YAML source to LF so the line-level matchers match
  // uniformly (JS `.`/`$` don't cross `\r`, so a CRLF `tags:` line would never
  // match and fall to the lossy path). `eol` is re-applied to the frontmatter block at
  // assembly time; the body is kept byte-verbatim — the rewriter never edits it.
  // DECISION: a frontmatter block with internally-mixed endings normalises to
  // the detected `eol`; the body's own (possibly mixed) endings are untouched.
  const yamlSource = block.source.replace(/\r\n/g, '\n');
  return {
    yamlSource,
    body,
    hasFrontmatter: true,
    eol,
    hadBom,
    fences: { open: block.open, close: block.close, closeEnd: block.closeEol },
  };
}

function loadYamlObject(yamlSource: string): Record<string, unknown> | null {
  if (!yamlSource.trim()) return {};
  let loaded: unknown;
  try {
    // Must be the SAME parser the CST engine uses for its value-compare
    // (`doc.toJS()`): a different parser could read an untouched `1_000` as a
    // number and make the engine rewrite it as "changed". `uniqueKeys` makes a
    // duplicate mapping key a fatal error, so we refuse the write rather than
    // round-trip a block we can't model. The core schema resolves no timestamp
    // or merge tag, so an unquoted date stays a `string` and `<<` a literal key.
    const doc = parseDocument(yamlSource, { uniqueKeys: true, logLevel: 'error' });
    if (doc.errors.length > 0) return null;
    loaded = doc.toJS();
  } catch {
    return null;
  }
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return null;
  return loaded as Record<string, unknown>;
}

/**
 * Last resort, matching `assembleMarkdownFile`'s full-dump fallback: only
 * reached when `patchFrontmatterSourceCst` can't patch the block. Null when
 * the dump would change a value the tag change didn't touch (`02134` →
 * `2134`, a dropped YAML tag); the caller then leaves the note alone.
 * `lineWidth: 0` disables folding.
 */
function dumpYaml(yamlSource: string, fm: Record<string, unknown>): string | null {
  const dumped = new Document(fm).toString({ lineWidth: 0 }).trimEnd();
  return dumpPreservesUntouched(yamlSource, dumped, fm) ? dumped : null;
}

/**
 * Rebuilds a `.md` file from an edited (LF) frontmatter block plus the original
 * body. The YAML lines get `eol`; the fence lines, the closing fence's line
 * break and the body are the file's own, byte-verbatim (a new block gets bare
 * `---` fences).
 *
 * Emits EXACTLY one separator newline before the closing `---`: the fence
 * regex strips precisely one `\n` off the interior, so adding it back
 * reconstructs the interior byte-for-byte — preserving trailing blank lines,
 * which are part of the VALUE of a `notes: |+` keep-chomped block scalar.
 */
function reassemble(fmTextLf: string, note: SplitNote): string {
  const { eol, fences } = note;
  const open = fences?.open ?? '---';
  const close = fences?.close ?? '---';
  const closeEnd = fences ? fences.closeEnd : eol;
  const fmRegion = `${open}\n${fmTextLf}\n${close}`.replace(/\n/g, eol) + closeEnd;
  // Re-emit the leading UTF-8 BOM the source carried so a Notepad-saved
  // file's encoding round-trips.
  const bomPrefix = note.hadBom ? String.fromCharCode(0xfeff) : '';
  return `${bomPrefix}${fmRegion}${note.body}`;
}

function normaliseTagsField(value: unknown): { tags: string[]; wasString: boolean } | null {
  const parsed = parseTagsField(value);
  if (!parsed.recognised) return null;
  return { tags: parsed.tags, wasString: parsed.wasString };
}

interface LocatedTagsField {
  startLine: number;
  endLine: number; // exclusive
  style: 'flow' | 'block' | 'scalar' | 'empty';
  tags: string[];
}

const TAGS_HEADER_RE = /^tags\s*:(.*)$/;
const BLOCK_ITEM_RE = /^(\s+)-\s+(.*)$/;
const QUOTED_RE = /^['"]([^'"]*)['"]$/;

function unquote(raw: string): string {
  const trimmed = raw.trim();
  const match = QUOTED_RE.exec(trimmed);
  return match?.[1] ?? trimmed;
}

/**
 * True when a raw block/scalar item the hand-rolled tokenizer would accept
 * actually carries a shape it CAN'T represent losslessly, so
 * `locateTagsField` must decline (return null) and route the edit through the
 * load → CST fallback. The fast path would otherwise succeed with a WRONG
 * value, silently mangling a SIBLING tag on re-emit. The shapes:
 *  - an inline `# comment` after the value (`beta # note`) — swallowed into the
 *    tag text by the naive matcher;
 *  - an embedded / YAML-escaped quote (`'it''s'`) — `QUOTED_RE` can't unwrap it;
 *  - (handled at the flow/scalar call sites) a quote that hides a comma.
 * A cleanly single/double-quoted item (`'@home'`) is safe — `unquote` handles
 * it — so it stays on the fast path.
 */
function itemUnsafeForLinePath(rawItem: string): boolean {
  const t = rawItem.trim();
  if (QUOTED_RE.test(t)) return false; // cleanly '...'/"..." — unquote round-trips it
  if (/['"]/.test(t)) return true; // embedded / escaped quote (e.g. 'it''s')
  if (/(^|\s)#/.test(t)) return true; // inline comment after the value
  // An UNQUOTED leading `&`/`*` is an anchor/alias, never a literal tag
  // (indicator chars are illegal at plain-scalar start); declining routes the
  // field to the fallback, whose anchored-field skip leaves the file untouched.
  if (/^[&*]/.test(t)) return true;
  return false;
}

/**
 * Locates the top-level `tags:` field in a raw YAML source and reports the
 * line range plus current tag values. Only recognises shapes we can rewrite
 * losslessly:
 *  - Flow list: `tags: [a, b]` (single line)
 *  - Block list: `tags:\n  - a\n  - b`
 *  - Scalar / comma string: `tags: a, b` or `tags: a`
 *  - Empty: `tags:` with no follow-up items
 *
 * Returns null on shapes the rewriter can't handle (e.g. tags pointed at by
 * a YAML anchor `tags: *xref`, nested mapping under tags, a flow list that
 * wraps onto further lines, a flow mapping). The load → patch fallback covers
 * those.
 */
function locateTagsField(yamlSource: string): LocatedTagsField | null {
  const lines = yamlSource.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue; // i < lines.length; narrow for the type-checker
    const match = TAGS_HEADER_RE.exec(line);
    if (!match) continue;
    const headerRest = match[1] ?? '';
    // Reject anchored / aliased fields — too risky to rewrite via line edit.
    if (/[&*]/.test(headerRest)) return null;
    const rest = headerRest.trim();
    // A flow collection that doesn't close on this line (Prettier wraps long
    // lists) continues on lines this rewriter would leave behind, and any flow
    // mapping is beyond the comma-split. Both go to the CST fallback.
    if (rest.includes('{')) return null;
    if (rest.startsWith('[') && !rest.endsWith(']')) return null;
    if (rest === '') {
      const blockItems: string[] = [];
      let end = i + 1;
      while (end < lines.length) {
        const next = lines[end];
        if (next === undefined) break; // end < lines.length; narrow for the type-checker
        const itemMatch = BLOCK_ITEM_RE.exec(next);
        if (itemMatch) {
          const item = itemMatch[2] ?? '';
          // A block item carrying an inline comment or an escaped quote can't
          // be line-edited losslessly; decline so the CST fallback (which
          // tokenises it correctly) handles the whole field.
          if (itemUnsafeForLinePath(item)) return null;
          blockItems.push(unquote(item));
          end++;
          continue;
        }
        // Allow blank lines INSIDE the list (rare but legal YAML)
        if (/^\s*$/.test(next) && end + 1 < lines.length && BLOCK_ITEM_RE.test(lines[end + 1] ?? '')) {
          end++;
          continue;
        }
        break;
      }
      if (blockItems.length > 0) {
        return { startLine: i, endLine: end, style: 'block', tags: blockItems };
      }
      return { startLine: i, endLine: i + 1, style: 'empty', tags: [] };
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inside = rest.slice(1, -1).trim();
      // Any quoting inside a flow list can hide a comma (`[a, "b,c"]`) that
      // the naive comma-split would cut THROUGH, splitting one tag into two
      // malformed ones. Defer to the CST fallback, which parses flow correctly.
      // Filo emits bare / simple-quoted flow items, so this only diverts the
      // hostile (externally-authored) shapes.
      if (/['"]/.test(inside)) return null;
      const items = inside === ''
        ? []
        : inside.split(',').map((t) => unquote(t)).filter((t) => t.length > 0);
      return { startLine: i, endLine: i + 1, style: 'flow', tags: items };
    }
    // Single-line scalar — comma string or single value
    // A quote can hide a comma and a ` #` (whitespace-preceded) opens an
    // inline comment; either makes the comma-split mis-tokenise the field, so
    // defer to the CST fallback. `a#b` (no leading space) is a legal plain
    // scalar and stays on the fast path.
    if (/['"]/.test(rest) || /(^|\s)#/.test(rest)) return null;
    const items = rest
      .split(',')
      .map((t) => unquote(t))
      .filter((t) => t.length > 0);
    return { startLine: i, endLine: i + 1, style: 'scalar', tags: items };
  }
  return null;
}

/**
 * True when the YAML source has a top-level `tags:` key (any shape). Used by
 * `addTagToMarkdown` to distinguish "frontmatter has no tags field at all"
 * (safe to insert a fresh block via a line edit) from "tags field present but
 * `locateTagsField` declined it" (anchor/alias → take the load→dump fallback).
 * A nested or commented `tags:` won't match (`^tags`), so a fresh top-level
 * block is inserted in that case — top-level is the canonical location.
 */
function hasTagsHeader(yamlSource: string): boolean {
  return yamlSource.split('\n').some((line) => TAGS_HEADER_RE.test(line));
}

/**
 * True when the top-level `tags:` field carries a YAML anchor (`tags: &x
 * [..]`) or alias (`tags: *x`) ANYWHERE in its value range. `locateTagsField`
 * declines these — a line edit can't safely follow the reference — and the
 * load→dump fallback would RESOLVE the reference and re-emit the whole block
 * (anchors on other keys dropped, aliases inlined, comments lost), a larger
 * and more surprising mutation than the documented comment loss. Callers skip
 * the rewrite entirely in this case, leaving the file byte-for-byte untouched.
 *
 * Scans the field's FULL value range (header rest, each flow item, each block
 * item) so an alias INSIDE the collection (`tags: [*shared]`) is caught. An
 * UNQUOTED leading `&`/`*` is always an anchor/alias; a quoted tag containing
 * them starts with the quote and is unaffected.
 */
function tagsFieldIsAnchored(yamlSource: string): boolean {
  const startsAnchored = (raw: string): boolean => /^[&*]/.test(raw.trim());
  const lines = yamlSource.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = TAGS_HEADER_RE.exec(lines[i] ?? '');
    if (!match) continue;
    const value = (match[1] ?? '').trim();
    if (startsAnchored(value)) return true;
    if (value.startsWith('[')) {
      // Flow list — check each comma-separated item (a quote can hide a comma,
      // but a HIDDEN comma can only over-split, never make a non-anchored item
      // LOOK anchored: an unquoted leading `&`/`*` survives any split).
      const inside = value.endsWith(']') ? value.slice(1, -1) : value.slice(1);
      return inside.split(',').some((item) => startsAnchored(item));
    }
    if (value === '') {
      // Block list — scan the item lines (same walk as locateTagsField,
      // including blank lines inside the list).
      for (let j = i + 1; j < lines.length; j++) {
        const itemMatch = BLOCK_ITEM_RE.exec(lines[j] ?? '');
        if (itemMatch) {
          if (startsAnchored(itemMatch[2] ?? '')) return true;
          continue;
        }
        if (/^\s*$/.test(lines[j] ?? '') && BLOCK_ITEM_RE.test(lines[j + 1] ?? '')) continue;
        break;
      }
    }
    return false;
  }
  return false;
}

/**
 * Renders a single tag scalar with exactly the quoting YAML requires, as a
 * one-element FLOW sequence (`[scalar]`) with the brackets sliced off: flow is
 * the strictest context (commas / brackets / leading indicator chars are all
 * special there), so a scalar safe in flow is also safe as a block item. Bare
 * emission would turn `@home`, `123`, `null`, a comma-bearing name etc. into
 * invalid or type-coerced YAML.
 *
 * `version: '1.1'` gives deliberately conservative quoting: `yes`/`no`/`on`/
 * `off`, `1_000`, `2024-01-01`, `1:30` are all quoted so the tag stays a STRING
 * for every reader (YAML-1.1 tools included). `singleQuote: true` prefers
 * single quotes (double where single can't represent the string). The
 * `version` MUST sit on the `Document` (it selects the schema at
 * construction); passing it only to `toString` does not apply 1.1.
 *
 * Exported for the parity test in `tagRewriter.test.ts`; otherwise tag-internal.
 */
export function emitTagScalar(tag: string): string {
  const doc = new Document([tag], { version: '1.1' });
  if (isSeq(doc.contents)) doc.contents.flow = true;
  return doc
    .toString({ lineWidth: 0, singleQuote: true })
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .trim();
}

function renderTagsField(loc: LocatedTagsField, nextTags: string[]): string[] {
  if (nextTags.length === 0) {
    if (loc.style === 'scalar' || loc.style === 'flow') {
      return ['tags: []'];
    }
    return ['tags:'];
  }
  if (loc.style === 'flow') {
    return [`tags: [${nextTags.map(emitTagScalar).join(', ')}]`];
  }
  if (loc.style === 'scalar') {
    // The comma-separated string form can't host a quoted item (the quotes
    // would re-parse as part of the tag). Keep the string shape only while
    // every tag is bare-safe; the moment one needs quoting, upgrade to a flow
    // sequence so the quoting is legal.
    if (nextTags.every((t) => emitTagScalar(t) === t)) {
      return [`tags: ${nextTags.join(', ')}`];
    }
    return [`tags: [${nextTags.map(emitTagScalar).join(', ')}]`];
  }
  // Block / empty — emit block form, each item quoted iff YAML needs it.
  const rendered = ['tags:'];
  for (const tag of nextTags) rendered.push(`  - ${emitTagScalar(tag)}`);
  return rendered;
}

function applyTagsLineRewrite(
  yamlSource: string,
  transform: (tags: string[]) => string[] | null,
): string | null {
  const loc = locateTagsField(yamlSource);
  if (!loc) return null;
  const nextTags = transform(loc.tags);
  if (nextTags === null) return null;
  if (
    nextTags.length === loc.tags.length &&
    nextTags.every((t, idx) => t === loc.tags[idx])
  ) {
    // No change — caller can short-circuit on the original source.
    return yamlSource;
  }
  const lines = yamlSource.split('\n');
  const head = lines.slice(0, loc.startLine);
  const tail = lines.slice(loc.endLine);
  const replacement = renderTagsField(loc, nextTags);
  const candidate = [...head, ...replacement, ...tail].join('\n');
  // The line tokenizer can't see every YAML shape (a plain scalar folded onto
  // the next line, a block item that continues). Accept its edit only when the
  // result parses to exactly the intended tags with every other key unchanged;
  // otherwise the CST fallback, which parses the real structure, takes over.
  return lineRewriteHolds(yamlSource, candidate, nextTags) ? candidate : null;
}

function lineRewriteHolds(before: string, after: string, nextTags: string[]): boolean {
  const now = loadYamlObject(after);
  if (!now) return false;
  // A block that didn't parse before (`[#tag]`: a `#` that YAML reads as a
  // comment) has no other keys any reader saw; an edit that leaves it parsing
  // with the intended tags only repairs it.
  const was = loadYamlObject(before);
  // Every item counts, whatever type it parses as: the line path re-emits a
  // `2024` item as the string '2024', which is still the same tag.
  const raw = now.tags;
  const tags = Array.isArray(raw)
    ? raw.map((t) => String(t))
    : typeof raw === 'string' ? normaliseTagsField(raw)?.tags : undefined;
  if (!tags || tags.length !== nextTags.length) return false;
  if (!tags.every((t, i) => t === nextTags[i])) return false;
  const others = (o: Record<string, unknown>): string =>
    JSON.stringify(Object.entries(o).filter(([k]) => k !== 'tags'));
  return !was || others(was) === others(now);
}

/**
 * Rewrites the frontmatter `tags:` entry, replacing `oldTag` with `newTag`.
 * Body text is left untouched.
 */
export function rewriteTagInMarkdown(
  rawContent: string,
  oldTag: string,
  newTag: string,
): string {
  if (!oldTag || !newTag || oldTag === newTag) return rawContent;

  const note = splitFrontmatter(rawContent);
  const { yamlSource, hasFrontmatter } = note;
  if (!hasFrontmatter) return rawContent;

  // Preferred path: rewrite only the `tags:` line range,
  // preserving every other YAML byte (comments, ordering, indentation).
  const lineRewrite = applyTagsLineRewrite(yamlSource, (tags) => {
    let changed = false;
    const renamed = tags.map((t) => {
      const bare = t.replace(/^#/, '');
      if (tagsEqual(bare, oldTag)) {
        changed = true;
        return t.startsWith('#') ? `#${newTag}` : newTag;
      }
      return t;
    });
    // Dedup after the rename so a merge into an existing tag
    // doesn't leave `[review, review]`.
    return changed ? dedupeTags(renamed) : null;
  });
  if (lineRewrite !== null) {
    if (lineRewrite === yamlSource) return rawContent;
    return reassemble(lineRewrite, note);
  }

  // An anchored/aliased tags field can't be line-edited; rather than
  // expand it through the lossy dump path, skip the rewrite entirely.
  if (tagsFieldIsAnchored(yamlSource)) return rawContent;

  // Fallback: load → modify → source-preserving patch. Covers shapes the line
  // rewriter refused (e.g. nested mappings).
  const fm = loadYamlObject(yamlSource);
  if (!fm) return rawContent;

  const tagsField = normaliseTagsField(fm.tags);
  if (!tagsField) return rawContent;

  let changed = false;
  const renamed = tagsField.tags.map((t) => {
    const bare = t.replace(/^#/, '');
    if (tagsEqual(bare, oldTag)) {
      changed = true;
      return t.startsWith('#') ? `#${newTag}` : newTag;
    }
    return t;
  });
  if (!changed) return rawContent;

  const next = dedupeTags(renamed);
  fm.tags = tagsField.wasString ? next.join(', ') : next;
  // Patch the original YAML source-preservingly; the lossy dump is a last
  // resort if the engine can't parse the block as a mapping.
  const patchedRename = patchFrontmatterSourceCst(yamlSource, fm);
  // The engine refuses a non-scalar mapping key (`[a, b]: x`); the dump would
  // rewrite that key as its stringified twin. Skip instead.
  if (patchedRename === null && frontmatterSourceHasNonScalarKey(yamlSource)) return rawContent;
  const renamedYaml = patchedRename ?? dumpYaml(yamlSource, fm);
  return renamedYaml === null ? rawContent : reassemble(renamedYaml, note);
}

/**
 * Removes a tag from the frontmatter `tags:` list. Body text is untouched.
 */
export function removeTagFromMarkdown(rawContent: string, tag: string): string {
  if (!tag) return rawContent;

  const note = splitFrontmatter(rawContent);
  const { yamlSource, hasFrontmatter } = note;
  if (!hasFrontmatter) return rawContent;

  // Line-level rewrite preserves all other YAML lines verbatim.
  const matches = (t: string) => tagsEqual(t.replace(/^#/, ''), tag);
  const lineRewrite = applyTagsLineRewrite(yamlSource, (tags) => {
    const next = tags.filter((t) => !matches(t));
    return next.length === tags.length ? null : next;
  });
  if (lineRewrite !== null) {
    if (lineRewrite === yamlSource) return rawContent;
    return reassemble(lineRewrite, note);
  }

  // Skip an anchored/aliased tags field instead of expanding it.
  if (tagsFieldIsAnchored(yamlSource)) return rawContent;

  // Fallback: load → source-preserving patch (yaml package).
  const fm = loadYamlObject(yamlSource);
  if (!fm) return rawContent;

  const tagsField = normaliseTagsField(fm.tags);
  if (!tagsField) return rawContent;

  const next = tagsField.tags.filter((t) => !matches(t));
  if (next.length === tagsField.tags.length) return rawContent;

  fm.tags = tagsField.wasString ? next.join(', ') : next;
  // Source-preserving patch; the lossy dump is a last resort.
  const patchedRemove = patchFrontmatterSourceCst(yamlSource, fm);
  // Non-scalar mapping key: refuse rather than dump (see rename).
  if (patchedRemove === null && frontmatterSourceHasNonScalarKey(yamlSource)) return rawContent;
  const removed = patchedRemove ?? dumpYaml(yamlSource, fm);
  return removed === null ? rawContent : reassemble(removed, note);
}

/**
 * Adds a tag to the frontmatter `tags:` array. Idempotent — if the tag is
 * already present (with or without leading `#`), the input is returned
 * unchanged. When the file has no frontmatter block, one is created.
 */
export function addTagToMarkdown(rawContent: string, tag: string): string {
  const bareTag = tag.replace(/^#/, '').trim();
  if (!bareTag) return rawContent;

  const note = splitFrontmatter(rawContent);
  const { yamlSource, hasFrontmatter } = note;

  if (!hasFrontmatter) {
    return reassemble(`tags:\n  - ${emitTagScalar(bareTag)}`, note);
  }

  // Frontmatter present but no `tags:` field: insert a fresh block via a
  // line-level edit so the rest of the YAML survives byte-for-byte. A file that
  // already has a `tags:` field keeps the fallback path so its string→array
  // upgrade semantics are preserved.
  if (!hasTagsHeader(yamlSource)) {
    // APPEND after every existing line — inserting before a trailing blank
    // line would steal a blank a `notes: |+` keep-chomped scalar owns. An empty
    // FM source starts from no lines so there's no phantom blank line.
    const lines = yamlSource === '' ? [] : yamlSource.split('\n');
    lines.push('tags:', `  - ${emitTagScalar(bareTag)}`);
    const candidate = lines.join('\n');
    // The line insert assumes a block mapping; a root-level FLOW mapping
    // (`{title: X}`) would become invalid YAML. Only take the insert when the
    // result still parses; otherwise fall through to the load→patch path.
    if (loadYamlObject(candidate)) {
      return reassemble(candidate, note);
    }
  }

  // Skip an anchored/aliased tags field instead of expanding it via dump.
  if (tagsFieldIsAnchored(yamlSource)) return rawContent;

  // Unparseable / non-object YAML → refuse the write. Proceeding on `{}` would
  // emit ONLY a `tags:` block and erase every other frontmatter key.
  const fm = loadYamlObject(yamlSource);
  if (!fm) return rawContent;

  const tagsField = normaliseTagsField(fm.tags) ?? { tags: [], wasString: false };

  if (tagsField.tags.some((t) => tagsEqual(t.replace(/^#/, ''), bareTag))) return rawContent;

  tagsField.tags.push(bareTag);
  // Always emit the array form so external editors see a consistent YAML
  // shape regardless of whether the file originally stored tags as a
  // comma-separated string.
  fm.tags = tagsField.tags;

  // Source-preserving patch; the lossy dump is a last resort.
  const patchedAdd = patchFrontmatterSourceCst(yamlSource, fm);
  // Non-scalar mapping key: refuse rather than dump (see rename).
  if (patchedAdd === null && frontmatterSourceHasNonScalarKey(yamlSource)) return rawContent;
  const added = patchedAdd ?? dumpYaml(yamlSource, fm);
  return added === null ? rawContent : reassemble(added, note);
}
