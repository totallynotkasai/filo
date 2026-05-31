import yaml from 'js-yaml';
import { parseTagsField } from '../utils/normalizeTagsField';
import { patchFrontmatterSource } from './frontmatterEngine';

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
 * anchors, custom fields) byte-identical. The js-yaml load/dump fallback
 * remains for shapes the line rewriter can't safely express (nested blocks,
 * unusual whitespace), since losing a user's comments is worse than
 * occasionally taking the older path.
 */

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

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
} {
  const eol = detectEol(raw);
  const fenced = FRONTMATTER_FENCE.exec(raw);
  if (!fenced) {
    return { yamlSource: '', body: raw, hasFrontmatter: false, hadTrailingNewline: false, eol };
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
  const yamlSource = fenced[1].replace(/\r\n/g, '\n');
  return {
    yamlSource,
    body: fenced[2] ?? '',
    hasFrontmatter: true,
    hadTrailingNewline: /\n$/.test(yamlSource),
    eol,
  };
}

function loadYamlObject(yamlSource: string): Record<string, unknown> | null {
  if (!yamlSource.trim()) return {};
  let loaded: unknown;
  try {
    loaded = yaml.load(yamlSource);
  } catch {
    return null;
  }
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return null;
  return loaded as Record<string, unknown>;
}

function dumpYaml(fm: Record<string, unknown>): string {
  return yaml.dump(fm, { lineWidth: -1, noRefs: true }).trimEnd();
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
): string {
  const sep = hadTrailingNewline ? '' : '\n';
  const fmRegion = `---\n${fmTextLf}${sep}---\n`.replace(/\n/g, eol);
  const bodyTrailing = body.length === 0 || body.endsWith('\n') ? '' : eol;
  return `${fmRegion}${body}${bodyTrailing}`;
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
  return match ? match[1] : trimmed;
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
 * a YAML anchor `tags: *xref`, nested mapping under tags). The js-yaml
 * fallback covers those.
 */
function locateTagsField(yamlSource: string): LocatedTagsField | null {
  const lines = yamlSource.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = TAGS_HEADER_RE.exec(line);
    if (!match) continue;
    // Reject anchored / aliased fields — too risky to rewrite via line edit.
    if (/[&*]/.test(match[1])) return null;
    const rest = match[1].trim();
    if (rest === '') {
      const blockItems: string[] = [];
      let end = i + 1;
      while (end < lines.length) {
        const next = lines[end];
        const itemMatch = BLOCK_ITEM_RE.exec(next);
        if (itemMatch) {
          blockItems.push(unquote(itemMatch[2]));
          end++;
          continue;
        }
        // Allow blank lines INSIDE the list (rare but legal YAML)
        if (/^\s*$/.test(next) && end + 1 < lines.length && BLOCK_ITEM_RE.test(lines[end + 1])) {
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
      const items = inside === ''
        ? []
        : inside.split(',').map((t) => unquote(t)).filter((t) => t.length > 0);
      return { startLine: i, endLine: i + 1, style: 'flow', tags: items };
    }
    // Single-line scalar — comma string or single value
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
 * True when the top-level `tags:` field's value is a YAML anchor (`tags: &x
 * [..]`) or alias (`tags: *x`). `locateTagsField` declines these — a line edit
 * can't safely follow the reference — and the load→dump fallback would EXPAND
 * the anchor (`dump({ noRefs: true })`) and re-emit the whole block, a larger
 * and more surprising mutation than the documented comment loss. Callers skip
 * the rewrite entirely in this case, leaving the file byte-for-byte untouched.
 * Detection is precise (the value starts with `&`/`*`) so a tag whose text
 * merely contains those characters still takes the established path. (7.5)
 */
function tagsFieldIsAnchored(yamlSource: string): boolean {
  for (const line of yamlSource.split('\n')) {
    const match = TAGS_HEADER_RE.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    return value.startsWith('&') || value.startsWith('*');
  }
  return false;
}

/**
 * Renders a single tag scalar with exactly the quoting YAML requires, using
 * js-yaml as the oracle (1.5 / 1.6). Dumps the tag as a one-element FLOW
 * sequence (`[scalar]`) and slices off the brackets: flow is the strictest
 * context (commas / brackets / leading indicator chars are all special there),
 * so a scalar safe in flow is also safe as a block item. Without this the
 * rewriter emitted every tag BARE — so `@home`, `123`, `null`, a comma-bearing
 * name etc. produced invalid or type-coerced YAML, and removing one tag
 * stripped the quotes off a quoted sibling (`[draft, "@home"]` → bare `@home`).
 */
function emitTagScalar(tag: string): string {
  return yaml.dump([tag], { flowLevel: 0, lineWidth: -1 }).replace(/\n$/, '').slice(1, -1).trim();
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

  const { yamlSource, body, hasFrontmatter, hadTrailingNewline, eol } = splitFrontmatter(rawContent);
  if (!hasFrontmatter) return rawContent;

  // Phase 31 C3.2 — preferred path: rewrite only the `tags:` line range,
  // preserving every other YAML byte (comments, ordering, indentation).
  const lineRewrite = applyTagsLineRewrite(yamlSource, (tags) => {
    let changed = false;
    const next = tags.map((t) => {
      const bare = t.replace(/^#/, '');
      if (tagsEqual(bare, oldTag)) {
        changed = true;
        return t.startsWith('#') ? `#${newTag}` : newTag;
      }
      return t;
    });
    return changed ? next : null;
  });
  if (lineRewrite !== null) {
    if (lineRewrite === yamlSource) return rawContent;
    return reassemble(lineRewrite, body, hadTrailingNewline, eol);
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
  const next = tagsField.tags.map((t) => {
    const bare = t.replace(/^#/, '');
    if (tagsEqual(bare, oldTag)) {
      changed = true;
      return t.startsWith('#') ? `#${newTag}` : newTag;
    }
    return t;
  });
  if (!changed) return rawContent;

  fm.tags = tagsField.wasString ? next.join(', ') : next;
  // Audit2 4.8 — the fallback no longer re-dumps the whole object (which dropped
  // comments / key order). Patch the original YAML source source-preservingly via
  // the `yaml` Document engine, keeping the lossy dump only as a last resort if
  // the engine can't parse the block as a mapping.
  return reassemble(patchFrontmatterSource(yamlSource, fm) ?? dumpYaml(fm), body, false, eol);
}

/**
 * Removes a tag from the frontmatter `tags:` list. Body text is untouched.
 */
export function removeTagFromMarkdown(rawContent: string, tag: string): string {
  if (!tag) return rawContent;

  const { yamlSource, body, hasFrontmatter, hadTrailingNewline, eol } = splitFrontmatter(rawContent);
  if (!hasFrontmatter) return rawContent;

  // Phase 31 C3.2 — line-level rewrite preserves all other YAML lines verbatim.
  const matches = (t: string) => tagsEqual(t.replace(/^#/, ''), tag);
  const lineRewrite = applyTagsLineRewrite(yamlSource, (tags) => {
    const next = tags.filter((t) => !matches(t));
    return next.length === tags.length ? null : next;
  });
  if (lineRewrite !== null) {
    if (lineRewrite === yamlSource) return rawContent;
    return reassemble(lineRewrite, body, hadTrailingNewline, eol);
  }

  // 7.5 — skip an anchored/aliased tags field instead of expanding it.
  if (tagsFieldIsAnchored(yamlSource)) return rawContent;

  // Fallback: js-yaml load/dump path.
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
  return reassemble(patchFrontmatterSource(yamlSource, fm) ?? dumpYaml(fm), body, false, eol);
}

/**
 * Adds a tag to the frontmatter `tags:` array. Idempotent — if the tag is
 * already present (with or without leading `#`), the input is returned
 * unchanged. When the file has no frontmatter block, one is created.
 */
export function addTagToMarkdown(rawContent: string, tag: string): string {
  const bareTag = tag.replace(/^#/, '').trim();
  if (!bareTag) return rawContent;

  const { yamlSource, body, hasFrontmatter, hadTrailingNewline, eol } = splitFrontmatter(rawContent);

  if (!hasFrontmatter) {
    return reassemble(`tags:\n  - ${emitTagScalar(bareTag)}`, body, false, eol);
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
      return reassemble(candidate, body, hadTrailingNewline, eol);
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
  return reassemble(patchFrontmatterSource(yamlSource, fm) ?? dumpYaml(fm), body, false, eol);
}
