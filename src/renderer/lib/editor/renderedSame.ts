import type { MarkdownRenderer } from './minimalEscapes';

/**
 * Whether saving a note from the editor would change what the note says, as
 * the note's own Markdown parser reads it.
 *
 * The line-by-line check in `markdownSync.ts` knows a list of cosmetic
 * differences (bullet style, rule style, setext headings…). Past that list,
 * the two texts are rendered with markdown-it, the parser the note is loaded
 * with: when both give the same HTML, the save changes only how the note is
 * spelled, never what it shows. That covers, with no rule per shape:
 * - a blank line Filo puts between a paragraph and the list, heading, quote,
 *   fence, rule or table under it;
 * - list numbers (`1. 1. 1.` written `1. 2. 3.`, `01.` written `1.`);
 * - a list item's or quote's lazy continuation line, indented or marked;
 * - an unspaced `***` rule, an entity written as its character, a `"` in a
 *   link address written `%22`.
 *
 * Two things the HTML doesn't show still count as changes:
 * - link reference definitions (`[1]: https://…`). They render nothing, so a
 *   save that dropped one, or inlined it into its link, would pass unseen.
 *   Their parsed set must match.
 * - a backslash escape the file didn't have, in front of a character other
 *   Markdown apps give their own meaning to (`[[wiki links]]`, `![[embeds]]`,
 *   `#tags`, `==highlights==`, `$maths$`, `> [!callouts]`, `^block-ids`…).
 *   markdown-it reads `\[\[Page\]\]` and `[[Page]]` the same, but the other
 *   app wouldn't. Escapes of `*` and `_` don't count: `minimalEscapes.ts`
 *   manages them, and every flavour reads them as CommonMark does.
 */

/** Characters an escape added in front of would change for another app. */
const EXTENSION_SYNTAX = new Set(['[', ']', '!', '#', '$', '%', '=', '^', '|', '~', '<', '>', '{', '}', '`', ':', '@', '&']);

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/** How many times each ASCII punctuation character is backslash-escaped in `text`. */
export function escapeCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') continue;
    const next = text[i + 1] ?? '';
    if (!ASCII_PUNCTUATION.test(next)) continue;
    counts.set(next, (counts.get(next) ?? 0) + 1);
    i++;
  }
  return counts;
}

/** True when `after` escapes a character in `EXTENSION_SYNTAX` more often than `before` does. */
export function addsExtensionEscape(before: string, after: string): boolean {
  const had = escapeCounts(before);
  for (const [ch, n] of escapeCounts(after)) {
    if (EXTENSION_SYNTAX.has(ch) && n > (had.get(ch) ?? 0)) return true;
  }
  return false;
}

interface RenderEnv {
  references?: Record<string, { href?: string; title?: string }>;
}

function rendered(md: MarkdownRenderer, text: string): { html: string; references: string } {
  const env: RenderEnv = {};
  const html = md.render(text, env);
  const refs = env.references ?? {};
  const references = JSON.stringify(Object.keys(refs).sort().map((k) => [k, refs[k]?.href ?? '', refs[k]?.title ?? '']));
  return { html, references };
}

/**
 * True when `md` reads `original` and `roundTripped` as the same note (same
 * HTML, same reference definitions), and `roundTripped` adds no escape
 * another app would read differently.
 */
export function rendersSame(original: string, roundTripped: string, md: MarkdownRenderer): boolean {
  if (addsExtensionEscape(original, roundTripped)) return false;
  const a = rendered(md, original);
  const b = rendered(md, roundTripped);
  return a.html === b.html && a.references === b.references;
}
