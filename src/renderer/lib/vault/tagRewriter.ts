import { Document, parseDocument, isSeq } from 'yaml';
import { parseTagsField } from '../utils/normalizeTagsField';
import { patchFrontmatterSourceCst, frontmatterSourceHasNonScalarKey } from './frontmatterCstModel';

/**
 * Frontmatter-only tag rewriter.
 *
 * Filo treats a `.md` file's YAML `tags:` list as the canonical tag source.
 * Inline `#foo` runs in the body are styled via the TipTap mark but carry no
 * tagging semantics, so we never edit body text here. Each function returns
 * a string byte-identical to its input when no frontmatter rewrites happened,
 * letting callers short-circuit the write.
 *
 * Phase 31 C3.2 — preferred path is now a line-level rewrite that touches
 * ONLY the `tags:` field, leaving every other YAML line (including comments,
 * anchors, custom fields) byte-identical. The load → source-preserving patch
 * fallback remains for shapes the line rewriter can't safely express (nested
 * blocks, unusual whitespace), since losing a user's comments is worse than
 * occasionally taking the older path.
 *
 * Phase 6.4 — the tag path is now js-yaml-free: the load (`loadYamlObject`),
 * the last-resort dump (`dumpYaml`), and the per-tag quoting oracle
 * (`emitTagScalar`) all run on the `yaml` package, the SAME parser the read
 * path (`markdownSync.parseMarkdownFile`) and the source-preserving write
 * engine (`frontmatterCstModel`) use. One parser end-to-end closes the
 * cross-parser "looks changed but isn't" seam (M2) in the fallback path too.
 */

// 6.4.M9 — `[ \t]*` tolerates trailing horizontal whitespace on either fence
// line (`--- `). Without it, a trailing-space fence parsed as "no frontmatter"
// and `addTagToMarkdown` PREPENDED a second `---` block, duplicating frontmatter.
const FRONTMATTER_FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

/**
 * Audit 2.2 — case-insensitive tag-identity equality. Folds via
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
 * Audit-11 T1 — collapses tag-equal entries (case-insensitive, ignoring a
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

/**
 * Detects a file's line ending from its first line break. The rewriter
 * re-applies this to the frontmatter block on assembly so a CRLF file (the
 * Windows / Notepad / VS Code / Obsidian default) round-trips as CRLF rather
 * than being silently flipped to LF (1.4 — user decision: PRESERVE endings).
 */
function detectEol(raw: string): '\r\n' | '\n' {
  const m = /\r\n|\n/.exec(raw);
  return m && m[0] === '\r\n' ? '\r\n' : '\n';
}

function splitFrontmatter(raw: string): {
  yamlSource: string;
  body: string;
  hasFrontmatter: boolean;
  hadTrailingNewline: boolean;
  eol: '\r\n' | '\n';
  hadBom: boolean;
} {
  // Audit-4 DI-02 — strip a leading UTF-8 BOM before the fence match, mirroring
  // parseMarkdownFile (markdownSync.ts). FRONTMATTER_FENCE is anchored at `^---`;
  // a BOM file (Notepad / legacy Office "Save As UTF-8") therefore failed the
  // anchor → hasFrontmatter:false → addTagToMarkdown PREPENDED a second `tags:`
  // block, demoting the real frontmatter (title, dates, tags) into the body,
  // while rename/remove silently returned the file unchanged. `hadBom` is
  // re-emitted by `reassemble` so the user's encoding round-trips. (CRLF was
  // already handled at the fence; BOM was the gap.)
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const text = hadBom ? raw.slice(1) : raw;
  const eol = detectEol(text);
  const fenced = FRONTMATTER_FENCE.exec(text);
  if (!fenced) {
    return { yamlSource: '', body: text, hasFrontmatter: false, hadTrailingNewline: false, eol, hadBom };
  }
  // 1.4 — normalise the captured YAML source to LF so the line-level matchers
  // (`TAGS_HEADER_RE`, the block-item / blank-line checks) match uniformly.
  // Without this a `\r`-terminated `tags:` line never matched (JS `.`/`$` don't
  // cross `\r`), so every CRLF edit fell to the lossy dump path and `add`
  // spliced a duplicate key. `eol` is re-applied to the frontmatter block at
  // assembly time; the body (`fenced[2]`) is kept byte-verbatim — the rewriter
  // never edits it.
  // DECISION: a frontmatter block with internally-mixed endings normalises to
  // the detected `eol`; the body's own (possibly mixed) endings are untouched.
  const yamlSource = (fenced[1] ?? '').replace(/\r\n/g, '\n');
  return {
    yamlSource,
    body: fenced[2] ?? '',
    hasFrontmatter: true,
    hadTrailingNewline: /\n$/.test(yamlSource),
    eol,
    hadBom,
  };
}

function loadYamlObject(yamlSource: string): Record<string, unknown> | null {
  if (!yamlSource.trim()) return {};
  let loaded: unknown;
  try {
    // Phase 6.4 — parse with the `yaml` package (was js-yaml CORE_SCHEMA). This
    // is the SAME parser the read path and the source-preserving write engine
    // (`patchFrontmatterSourceCst`, `frontmatterCstModel`) use, which matters
    // beyond cleanup: the engine derives its value-compare object via `doc.toJS()`,
    // so a fallback object built with a DIFFERENT parser could disagree on a
    // scalar form and trip a phantom rewrite. js-yaml CORE read `1_000` as the
    // NUMBER 1000 while `doc.toJS()` keeps the STRING "1_000"; under the old split
    // an UNTOUCHED `1_000` sibling looked "changed" to the engine and was
    // value-only-spliced to `1000` on a tag-fallback edit (the M2 class). One
    // parser on both sides closes that seam. `uniqueKeys` makes a duplicate
    // mapping key a fatal `doc.errors` entry (parity with js-yaml, which threw),
    // so we refuse the write rather than round-trip a block we can't model.
    // The `yaml` core schema (like the prior CORE_SCHEMA) resolves no timestamp
    // or merge tag, so an unquoted date stays a `string` and `<<` a literal key.
    const doc = parseDocument(yamlSource, { uniqueKeys: true });
    if (doc.errors.length > 0) return null;
    loaded = doc.toJS();
  } catch {
    return null;
  }
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return null;
  return loaded as Record<string, unknown>;
}

function dumpYaml(fm: Record<string, unknown>): string {
  // Phase 6.4 — the last-resort dump now serialises with the `yaml` package (was
  // js-yaml), matching `assembleMarkdownFile`'s full-dump fallback so the whole
  // tag path is single-parser. Only reached when `patchFrontmatterSourceCst`
  // can't source-preservingly patch the block; a full dump has no source to
  // preserve, so it's lossless. `lineWidth: 0` disables folding (parity with the
  // prior js-yaml `lineWidth: -1`).
  return new Document(fm).toString({ lineWidth: 0 }).trimEnd();
}

/**
 * Rebuilds a `.md` file from an edited (LF) frontmatter block plus the original
 * body. The frontmatter region (fences + YAML) is emitted with `eol`; the body
 * is written byte-verbatim. `hadTrailingNewline` reproduces the rule that a
 * captured FM source already ending in a newline keeps that one separator
 * rather than gaining a second. Reduces to the historical LF output exactly
 * when `eol === '\n'`.
 */
function reassemble(
  fmTextLf: string,
  body: string,
  hadTrailingNewline: boolean,
  eol: '\r\n' | '\n',
  hadBom: boolean,
): string {
  const sep = hadTrailingNewline ? '' : '\n';
  const fmRegion = `---\n${fmTextLf}${sep}---\n`.replace(/\n/g, eol);
  const bodyTrailing = body.length === 0 || body.endsWith('\n') ? '' : eol;
  // Audit-4 DI-02 — re-emit the leading UTF-8 BOM the source carried so a
  // Notepad-saved file's encoding round-trips instead of being silently dropped.
  const bomPrefix = hadBom ? '﻿' : '';
  return `${bomPrefix}${fmRegion}${body}${bodyTrailing}`;
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
 * Audit-10 H1 — true when a raw block/scalar item the hand-rolled tokenizer
 * would accept actually carries a shape it CAN'T represent losslessly, so
 * `locateTagsField` must decline (return null) and route the edit through the
 * load → CST fallback instead — the same "can't line-edit → fall back" signal
 * already used for anchors. The fast path's failure mode is insidious: it
 * SUCCEEDS with a WRONG value rather than refusing, so a corrupted item is
 * re-emitted by `renderTagsField` and a SIBLING tag is silently mangled on the
 * next tag op. The three shapes:
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
  // 5.5 (Audit-16) — an UNQUOTED leading `&`/`*` is an anchor/alias, never a
  // literal tag (indicator chars are illegal at plain-scalar start). The naive
  // matcher used to accept `- *shared` as the literal tag "*shared"; declining
  // routes the field to the fallback, where the widened anchored-field skip
  // leaves the file untouched.
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
 * a YAML anchor `tags: *xref`, nested mapping under tags). The load → patch
 * fallback covers those.
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
    if (rest === '') {
      const blockItems: string[] = [];
      let end = i + 1;
      while (end < lines.length) {
        const next = lines[end];
        if (next === undefined) break; // end < lines.length; narrow for the type-checker
        const itemMatch = BLOCK_ITEM_RE.exec(next);
        if (itemMatch) {
          const item = itemMatch[2] ?? '';
          // H1 — a block item carrying an inline comment or an escaped quote
          // can't be line-edited losslessly; decline so the CST fallback (which
          // tokenises it correctly) handles the whole field. Returning null here
          // leaves the SIBLING tags byte-correct instead of re-emitting a value
          // the naive matcher mangled.
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
      // H1 — any quoting inside a flow list can hide a comma (`[a, "b,c"]`) that
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
    // H1 — a quote can hide a comma and a ` #` (whitespace-preceded) opens an
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
 * 5.5 (Audit-16) — the original check inspected only the START of the header
 * value, so an alias INSIDE the collection (`tags: [*shared]`, a block item
 * `- *shared`) reported "not anchored" and fell through to the dump. Scan the
 * field's FULL value range: the header rest, each flow item, and each block
 * item. Detection stays precise — an UNQUOTED leading `&`/`*` is always an
 * anchor/alias in YAML (they're indicator chars, illegal at plain-scalar
 * start), while a quoted tag whose text contains them starts with the quote
 * and still takes the established path. (7.5)
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
 * special there), so a scalar safe in flow is also safe as a block item. Without
 * this the rewriter emitted every tag BARE — so `@home`, `123`, `null`, a
 * comma-bearing name etc. produced invalid or type-coerced YAML, and removing
 * one tag stripped the quotes off a quoted sibling (`[draft, "@home"]` → bare
 * `@home`).
 *
 * Phase 6.4 — re-implemented on the `yaml` package (was js-yaml as the oracle),
 * removing the last js-yaml use from the tag path. `version: '1.1'` keeps the
 * DELIBERATELY conservative quoting js-yaml's default (YAML-1.1) `dump` produced:
 * `yes`/`no`/`on`/`off`, `1_000`, `2024-01-01`, `1:30` are all quoted so the tag
 * stays a STRING for every reader — YAML-1.1 external tools, AND the vault-index
 * CORE read under which an unquoted `1_000` would resolve to the NUMBER 1000.
 * `singleQuote: true` matches js-yaml's single-quote preference (the package
 * still upgrades to double quotes where a single quote can't represent the
 * string, e.g. an embedded backslash). The output is byte-identical to the prior
 * js-yaml oracle on the hostile-name table except two residual differences
 * (`'apos` → double- vs the old doubled single-quote; `=` → bare vs quoted),
 * both of which re-parse to the IDENTICAL string under js-yaml DEFAULT/CORE and
 * the `yaml` package in flow AND block context — pinned by the parity test in
 * `tagRewriter.test.ts`. The `version` MUST sit on the `Document` (it selects the
 * schema at construction); passing it only to `toString` does not apply 1.1.
 *
 * Exported for that parity test; otherwise tag-internal.
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
  return [...head, ...replacement, ...tail].join('\n');
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

  const { yamlSource, body, hasFrontmatter, hadTrailingNewline, eol, hadBom } = splitFrontmatter(rawContent);
  if (!hasFrontmatter) return rawContent;

  // Phase 31 C3.2 — preferred path: rewrite only the `tags:` line range,
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
    // Audit-11 T1 — dedup after the rename so a merge into an existing tag
    // doesn't leave `[review, review]`.
    return changed ? dedupeTags(renamed) : null;
  });
  if (lineRewrite !== null) {
    if (lineRewrite === yamlSource) return rawContent;
    return reassemble(lineRewrite, body, hadTrailingNewline, eol, hadBom);
  }

  // 7.5 — an anchored/aliased tags field can't be line-edited; rather than
  // expand it through the lossy dump path, skip the rewrite entirely.
  if (tagsFieldIsAnchored(yamlSource)) return rawContent;

  // Fallback: load → modify → dump. Loses comments inside frontmatter, but
  // covers shapes the line rewriter refused (e.g. nested mappings).
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

  // Audit-11 T1 — dedup the merged result here too (fallback dump path).
  const next = dedupeTags(renamed);
  fm.tags = tagsField.wasString ? next.join(', ') : next;
  // Audit2 4.8 — the fallback no longer re-dumps the whole object (which dropped
  // comments / key order). Patch the original YAML source source-preservingly via
  // the `yaml` Document engine, keeping the lossy dump only as a last resort if
  // the engine can't parse the block as a mapping.
  const patchedRename = patchFrontmatterSourceCst(yamlSource, fm);
  // 5.4 (Audit-16) — the engine refuses a non-scalar mapping key (`[a, b]: x`);
  // the dump would rewrite that key as its stringified twin. Skip instead.
  if (patchedRename === null && frontmatterSourceHasNonScalarKey(yamlSource)) return rawContent;
  return reassemble(patchedRename ?? dumpYaml(fm), body, false, eol, hadBom);
}

/**
 * Removes a tag from the frontmatter `tags:` list. Body text is untouched.
 */
export function removeTagFromMarkdown(rawContent: string, tag: string): string {
  if (!tag) return rawContent;

  const { yamlSource, body, hasFrontmatter, hadTrailingNewline, eol, hadBom } = splitFrontmatter(rawContent);
  if (!hasFrontmatter) return rawContent;

  // Phase 31 C3.2 — line-level rewrite preserves all other YAML lines verbatim.
  const matches = (t: string) => tagsEqual(t.replace(/^#/, ''), tag);
  const lineRewrite = applyTagsLineRewrite(yamlSource, (tags) => {
    const next = tags.filter((t) => !matches(t));
    return next.length === tags.length ? null : next;
  });
  if (lineRewrite !== null) {
    if (lineRewrite === yamlSource) return rawContent;
    return reassemble(lineRewrite, body, hadTrailingNewline, eol, hadBom);
  }

  // 7.5 — skip an anchored/aliased tags field instead of expanding it.
  if (tagsFieldIsAnchored(yamlSource)) return rawContent;

  // Fallback: load → source-preserving patch (yaml package).
  const fm = loadYamlObject(yamlSource);
  if (!fm) return rawContent;

  const tagsField = normaliseTagsField(fm.tags);
  if (!tagsField) return rawContent;

  const next = tagsField.tags.filter((t) => !matches(t));
  if (next.length === tagsField.tags.length) return rawContent;

  fm.tags = tagsField.wasString ? next.join(', ') : next;
  // Audit2 4.8 — the fallback no longer re-dumps the whole object (which dropped
  // comments / key order). Patch the original YAML source source-preservingly via
  // the `yaml` Document engine, keeping the lossy dump only as a last resort if
  // the engine can't parse the block as a mapping.
  const patchedRemove = patchFrontmatterSourceCst(yamlSource, fm);
  // 5.4 (Audit-16) — non-scalar mapping key: refuse rather than dump (see rename).
  if (patchedRemove === null && frontmatterSourceHasNonScalarKey(yamlSource)) return rawContent;
  return reassemble(patchedRemove ?? dumpYaml(fm), body, false, eol, hadBom);
}

/**
 * Adds a tag to the frontmatter `tags:` array. Idempotent — if the tag is
 * already present (with or without leading `#`), the input is returned
 * unchanged. When the file has no frontmatter block, one is created.
 */
export function addTagToMarkdown(rawContent: string, tag: string): string {
  const bareTag = tag.replace(/^#/, '').trim();
  if (!bareTag) return rawContent;

  const { yamlSource, body, hasFrontmatter, hadTrailingNewline, eol, hadBom } = splitFrontmatter(rawContent);

  if (!hasFrontmatter) {
    return reassemble(`tags:\n  - ${emitTagScalar(bareTag)}`, body, false, eol, hadBom);
  }

  // Phase 7.4 — frontmatter present but no `tags:` field: insert a fresh block
  // via a line-level edit so the rest of the YAML (comments, key order, blank
  // lines) survives byte-for-byte. The load→dump fallback below would discard
  // all of that for what is purely an additive change. Scoped to the no-field
  // case only — a file that already has a `tags:` field keeps the dump path so
  // its established string→array upgrade semantics are preserved.
  if (!hasTagsHeader(yamlSource)) {
    const lines = yamlSource.split('\n');
    // Insert before a single trailing blank line (if any) so the block sits
    // with the other keys and the frontmatter's trailing newline is preserved.
    const insertAt =
      lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(insertAt, 0, 'tags:', `  - ${emitTagScalar(bareTag)}`);
    const candidate = lines.join('\n');
    // 1.7 — the line insert assumes a block mapping. A root-level FLOW mapping
    // (`{title: X}`) or other non-block shape would become invalid YAML with a
    // block `tags:` appended (the 1.7 fuzzer caught exactly this). Only take the
    // formatting-preserving insert when the result still parses; otherwise fall
    // through to the load→dump path, which correctly merges tags into any
    // parseable object.
    if (loadYamlObject(candidate)) {
      return reassemble(candidate, body, hadTrailingNewline, eol, hadBom);
    }
  }

  // 7.5 — skip an anchored/aliased tags field instead of expanding it via dump.
  if (tagsFieldIsAnchored(yamlSource)) return rawContent;

  // 1.3 — on unparseable / non-object YAML `loadYamlObject` returns null. The
  // old `?? {}` proceeded on an empty object, so `yaml.dump` emitted ONLY a
  // `tags:` block and silently erased every other frontmatter key. Refuse the
  // write instead — the same guard `rewriteTagInMarkdown` / `removeTagFromMarkdown`
  // already use. Never destroy a block we couldn't parse.
  const fm = loadYamlObject(yamlSource);
  if (!fm) return rawContent;

  const tagsField = normaliseTagsField(fm.tags) ?? { tags: [], wasString: false };

  if (tagsField.tags.some((t) => tagsEqual(t.replace(/^#/, ''), bareTag))) return rawContent;

  tagsField.tags.push(bareTag);
  // Always emit the array form so external editors see a consistent YAML
  // shape regardless of whether the file originally stored tags as a
  // comma-separated string.
  fm.tags = tagsField.tags;

  // Audit2 4.8 — the fallback no longer re-dumps the whole object (which dropped
  // comments / key order). Patch the original YAML source source-preservingly via
  // the `yaml` Document engine, keeping the lossy dump only as a last resort if
  // the engine can't parse the block as a mapping.
  const patchedAdd = patchFrontmatterSourceCst(yamlSource, fm);
  // 5.4 (Audit-16) — non-scalar mapping key: refuse rather than dump (see rename).
  if (patchedAdd === null && frontmatterSourceHasNonScalarKey(yamlSource)) return rawContent;
  return reassemble(patchedAdd ?? dumpYaml(fm), body, false, eol, hadBom);
}
