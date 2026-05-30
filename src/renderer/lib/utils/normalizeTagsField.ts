/**
 * Single source of truth for parsing a YAML `tags:` field.
 *
 * Two callers in different shapes:
 *  - Frontmatter sync / vault index / equality checks need a *canonical*
 *    `string[]` they can compare and hash. That's `normalizeTagsField`.
 *  - The frontmatter rewriter (tagRewriter.ts) needs to round-trip the source
 *    YAML form (array vs comma-string) and preserve each tag's leading `#`
 *    decision. That's `parseTagsField`.
 *
 * Splitting them avoids the previous drift where two near-identical parsers
 * lived in lib/vault/ and could fall out of sync.
 */

export interface ParsedTagsField {
  /** Raw tag tokens exactly as they appeared (a leading `#` is preserved). */
  tags: string[];
  /** True when the source value was a comma/whitespace-separated string. */
  wasString: boolean;
  /** True when the source value was a recognised tags field shape. */
  recognised: boolean;
}

/**
 * Parses a YAML `tags:` value into round-trippable parts. Accepts:
 *   - YAML array form:        `tags: [foo, bar]`
 *   - Legacy string form:     `tags: "foo, bar"` or `tags: "foo bar"`
 * Anything else returns `{ tags: [], wasString: false, recognised: false }`.
 *
 * No trimming / dedupe / sort — callers that need a canonical view should
 * use `normalizeTagsField` instead.
 */
export function parseTagsField(value: unknown): ParsedTagsField {
  if (Array.isArray(value)) {
    return {
      tags: value.filter((t): t is string => typeof t === 'string'),
      wasString: false,
      recognised: true,
    };
  }
  if (typeof value === 'string') {
    if (!value.trim()) {
      return { tags: [], wasString: true, recognised: true };
    }
    return {
      tags: value.split(/[,\s]+/).filter(Boolean),
      wasString: true,
      recognised: true,
    };
  }
  return { tags: [], wasString: false, recognised: false };
}

/**
 * Canonical tag list. Used wherever Filo needs a stable, comparable view of a
 * `.md` file's frontmatter tags — equality checks, MiniSearch indexing,
 * divergence detection.
 *
 * Semantics (preserved from the legacy `normalizeTags`):
 *   - Drops empty / whitespace-only entries.
 *   - Strips a single leading `#`.
 *   - Dedupes (exact-string equality).
 *   - Sorts ascending.
 */
export function normalizeTagsField(value: unknown): string[] {
  const parsed = parseTagsField(value);
  const out: string[] = [];
  for (const raw of parsed.tags) {
    if (typeof raw !== 'string') continue;
    const bare = raw.replace(/^#/, '');
    if (!bare) continue;
    out.push(bare);
  }
  return Array.from(new Set(out)).sort();
}
