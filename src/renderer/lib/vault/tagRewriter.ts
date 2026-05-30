import yaml from 'js-yaml';
import { parseTagsField } from '../utils/normalizeTagsField';

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

function splitFrontmatter(raw: string): {
  yamlSource: string;
  body: string;
  hasFrontmatter: boolean;
  trailingNewline: string;
} {
  const fenced = FRONTMATTER_FENCE.exec(raw);
  if (!fenced) {
    return { yamlSource: '', body: raw, hasFrontmatter: false, trailingNewline: '' };
  }
  const yamlSource = fenced[1];
  return {
    yamlSource,
    body: fenced[2] ?? '',
    hasFrontmatter: true,
    trailingNewline: /\n$/.test(yamlSource) ? '\n' : '',
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

function dumpYaml(fm: Record<string, unknown>, trailingNewline: string): string {
  return yaml.dump(fm, { lineWidth: -1, noRefs: true }).replace(/\n?$/, '') + trailingNewline;
}

function assemble(yamlText: string, body: string): string {
  const bodyTrailing = body.length === 0 || body.endsWith('\n') ? '' : '\n';
  return `---\n${yamlText}\n---\n${body}${bodyTrailing}`;
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

function renderTagsField(loc: LocatedTagsField, nextTags: string[]): string[] {
  if (nextTags.length === 0) {
    if (loc.style === 'scalar' || loc.style === 'flow') {
      return ['tags: []'];
    }
    return ['tags:'];
  }
  if (loc.style === 'flow') {
    return [`tags: [${nextTags.join(', ')}]`];
  }
  if (loc.style === 'scalar') {
    return [`tags: ${nextTags.join(', ')}`];
  }
  // Block / empty — emit block form
  const rendered = ['tags:'];
  for (const tag of nextTags) rendered.push(`  - ${tag}`);
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

  const { yamlSource, body, hasFrontmatter, trailingNewline } = splitFrontmatter(rawContent);
  if (!hasFrontmatter) return rawContent;

  // Phase 31 C3.2 — preferred path: rewrite only the `tags:` line range,
  // preserving every other YAML byte (comments, ordering, indentation).
  const lineRewrite = applyTagsLineRewrite(yamlSource, (tags) => {
    let changed = false;
    const next = tags.map((t) => {
      const bare = t.replace(/^#/, '');
      if (bare === oldTag) {
        changed = true;
        return t.startsWith('#') ? `#${newTag}` : newTag;
      }
      return t;
    });
    return changed ? next : null;
  });
  if (lineRewrite !== null) {
    if (lineRewrite === yamlSource) return rawContent;
    return `---\n${lineRewrite}${trailingNewline ? '' : '\n'}---\n${body}${
      body.length === 0 || body.endsWith('\n') ? '' : '\n'
    }`;
  }

  // Fallback: load → modify → dump. Loses comments inside frontmatter, but
  // covers shapes the line rewriter refused (anchors, nested mappings).
  const fm = loadYamlObject(yamlSource);
  if (!fm) return rawContent;

  const tagsField = normaliseTagsField(fm.tags);
  if (!tagsField) return rawContent;

  let changed = false;
  const next = tagsField.tags.map((t) => {
    const bare = t.replace(/^#/, '');
    if (bare === oldTag) {
      changed = true;
      return t.startsWith('#') ? `#${newTag}` : newTag;
    }
    return t;
  });
  if (!changed) return rawContent;

  fm.tags = tagsField.wasString ? next.join(', ') : next;
  return assemble(dumpYaml(fm, trailingNewline).trimEnd(), body);
}

/**
 * Removes a tag from the frontmatter `tags:` list. Body text is untouched.
 */
export function removeTagFromMarkdown(rawContent: string, tag: string): string {
  if (!tag) return rawContent;

  const { yamlSource, body, hasFrontmatter, trailingNewline } = splitFrontmatter(rawContent);
  if (!hasFrontmatter) return rawContent;

  // Phase 31 C3.2 — line-level rewrite preserves all other YAML lines verbatim.
  const matches = (t: string) => t.replace(/^#/, '') === tag;
  const lineRewrite = applyTagsLineRewrite(yamlSource, (tags) => {
    const next = tags.filter((t) => !matches(t));
    return next.length === tags.length ? null : next;
  });
  if (lineRewrite !== null) {
    if (lineRewrite === yamlSource) return rawContent;
    return `---\n${lineRewrite}${trailingNewline ? '' : '\n'}---\n${body}${
      body.length === 0 || body.endsWith('\n') ? '' : '\n'
    }`;
  }

  // Fallback: js-yaml load/dump path.
  const fm = loadYamlObject(yamlSource);
  if (!fm) return rawContent;

  const tagsField = normaliseTagsField(fm.tags);
  if (!tagsField) return rawContent;

  const next = tagsField.tags.filter((t) => !matches(t));
  if (next.length === tagsField.tags.length) return rawContent;

  fm.tags = tagsField.wasString ? next.join(', ') : next;
  return assemble(dumpYaml(fm, trailingNewline).trimEnd(), body);
}

/**
 * Adds a tag to the frontmatter `tags:` array. Idempotent — if the tag is
 * already present (with or without leading `#`), the input is returned
 * unchanged. When the file has no frontmatter block, one is created.
 */
export function addTagToMarkdown(rawContent: string, tag: string): string {
  const bareTag = tag.replace(/^#/, '').trim();
  if (!bareTag) return rawContent;

  const { yamlSource, body, hasFrontmatter } = splitFrontmatter(rawContent);

  if (!hasFrontmatter) {
    const trailing = body.length === 0 || body.endsWith('\n') ? '' : '\n';
    return `---\ntags:\n  - ${bareTag}\n---\n${body}${trailing}`;
  }

  const fm = loadYamlObject(yamlSource) ?? {};

  const tagsField = normaliseTagsField(fm.tags) ?? { tags: [], wasString: false };

  if (tagsField.tags.some((t) => t.replace(/^#/, '') === bareTag)) return rawContent;

  tagsField.tags.push(bareTag);
  // Always emit the array form so external editors see a consistent YAML
  // shape regardless of whether the file originally stored tags as a
  // comma-separated string.
  fm.tags = tagsField.tags;

  const yamlText = yaml.dump(fm, { lineWidth: -1, noRefs: true }).trimEnd();
  return assemble(yamlText, body);
}
