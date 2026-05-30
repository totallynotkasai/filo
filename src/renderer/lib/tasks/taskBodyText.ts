/**
 * taskBodyText — extract a short plain-text preview from a Markdown body for
 * the Task List's inline-notes affordance.
 *
 * Strips frontmatter, leading headings, blank lines, and common Markdown
 * decoration (bold/italic/link wrappers) so the preview is comparable to the
 * non-decorated text a user would read.
 */

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

/**
 * Returns the markdown content with the leading YAML frontmatter block
 * removed. Idempotent if no frontmatter is present.
 */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_RE, '');
}

/**
 * Returns the first non-empty, non-heading line of the body as plain text,
 * truncated to `maxChars`. Returns an empty string if the body has no
 * meaningful content.
 *
 * Inline decoration handled:
 *   - `**bold**`, `*italic*`, `__bold__`, `_italic_` → unwrapped
 *   - `` `code` ``                                   → unwrapped
 *   - `[label](url)`                                 → `label`
 *
 * Block decoration handled:
 *   - `# ...` heading lines                          → skipped
 *   - `- [ ] item` / `* item` checklist bullets      → bullet stripped
 *   - Blockquote `> ...`                             → marker stripped
 */
export function getBodyPreview(markdown: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const body = stripFrontmatter(markdown);
  const lines = body.split(/\r?\n/);

  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;

    // Strip bullet / blockquote prefixes.
    line = line.replace(/^[-*+]\s+(\[[xX ]?\]\s+)?/, '');
    line = line.replace(/^>\s+/, '');
    if (!line) continue;

    // Strip simple inline decoration.
    line = line
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/`([^`]+)`/g, '$1');

    line = line.trim();
    if (!line) continue;

    if (line.length <= maxChars) return line;
    return line.slice(0, maxChars - 1).trimEnd() + '…';
  }
  return '';
}
