/**
 * Pure title-commit resolution shared by the TileHeader
 * and Frame inline title editors.
 *
 * The blur-commit logic both components share: trim the
 * plain text (falling back to a default when the user emptied it) and
 * suppress identity HTML when no rich-text marks were added — keeps the
 * schema slim and avoids `<p>foo</p>` being stored for an unstyled title.
 *
 * Extracted so the unmount-time commit (which must snapshot the TipTap
 * editor's value BEFORE tearing it down) shares one resolution path with the
 * normal blur/Enter commit, and so the resolution is unit-testable without a
 * component mount harness.
 */

export interface ResolvedTitleCommit {
  /** Trimmed one-line plain-text title; `fallback` when the user emptied the editor. */
  plain: string;
  /** Rich-text HTML, or undefined when it adds nothing over `plain`. */
  titleHtml: string | undefined;
}

/** Line breaks, with the spaces around them. */
const LINE_BREAKS = /[ \t]*(?:\r\n?|\n)+[ \t]*/g;

export function resolveTitleCommitValues(
  rawText: string,
  html: string,
  fallback: string,
): ResolvedTitleCommit {
  // A title is one line (`oneLine.ts`): a line break that reached the editor
  // anyway is a space, never a newline in `title:`. Spaces typed stay.
  const plain = rawText.replace(LINE_BREAKS, ' ').trim() || fallback;
  const stripped = html.replace(/<\/?p[^>]*>/gi, '').trim();
  const isPlain = stripped === plain || stripped === '';
  return { plain, titleHtml: isPlain ? undefined : html };
}

/** The text a title's HTML renders as, trimmed. */
function titleHtmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').trim();
}

/**
 * The formatted title to show, or `null` to show the plain title. Formatting
 * is the board's, but the words are the note's: once the title changes
 * anywhere (another board, a Document tab, another app), the stored
 * HTML no longer spells it and is ignored.
 */
export function visibleTitleHtml(titleHtml: string | undefined, title: string): string | null {
  if (!titleHtml || titleHtml.trim().length === 0) return null;
  return titleHtmlText(titleHtml) === title.trim() ? titleHtml : null;
}
