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
 * Both live here so the two parsers can't drift out of sync.
 */

export interface ParsedTagsField {
  /** Raw tag tokens exactly as they appeared (a leading `#` is preserved). */
  tags: string[];
  /** True when the source value was a comma-separated string. */
  wasString: boolean;
  /** True when the source value was a recognised tags field shape. */
  recognised: boolean;
}

/**
 * Parses a YAML `tags:` value into round-trippable parts. Accepts:
 *   - YAML array form:        `tags: [foo, bar]`
 *   - String form:            `tags: "foo, bar"` (commas only: `"Book 1"` is one tag)
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
      tags: value.split(',').map((t) => t.trim()).filter(Boolean),
      wasString: true,
      recognised: true,
    };
  }
  return { tags: [], wasString: false, recognised: false };
}

/**
 * Order-preserving tag list for the cache / display path. Applies the same
 * cleaning as {@link normalizeTagsField} — drops empty / whitespace-only
 * entries, strips a single leading `#`, and dedupes — but KEEPS the author's
 * first-seen order instead of sorting. Use this wherever a tile def's cached
 * tags should mirror the order the user wrote in the `.md` (e.g. frontmatter
 * reconcile), so the on-screen chips match the file.
 *
 * Dedupe is by exact string (identical to `normalizeTagsField`), so this and
 * `normalizeTagsField` always yield the SAME SET — they differ only in order.
 * That parity matters: divergence comparison still routes through the sorted
 * `normalizeTagsField` (see `frontmatterSync.valuesEqual`), so preserving the
 * authored order here can never re-trigger a spurious divergence.
 *
 * Comparison must still use `normalizeTagsField`.
 */
export function orderPreservingTagsField(value: unknown): string[] {
  const parsed = parseTagsField(value);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parsed.tags) {
    if (typeof raw !== 'string') continue;
    const bare = raw.replace(/^#/, '');
    if (!bare || seen.has(bare)) continue;
    seen.add(bare);
    out.push(bare);
  }
  return out;
}

/**
 * Canonical tag list. Used wherever Filo needs a stable, comparable view of a
 * `.md` file's frontmatter tags — equality checks,
 * divergence detection.
 *
 * Semantics:
 *   - Drops empty / whitespace-only entries.
 *   - Strips a single leading `#`.
 *   - Dedupes (exact-string equality).
 *   - Sorts ascending.
 *
 * This is `orderPreservingTagsField` + a stable sort, so the two never
 * disagree on membership — only on order.
 */
export function normalizeTagsField(value: unknown): string[] {
  return orderPreservingTagsField(value).sort();
}
