/**
 * Audit-17 4.1 / 4.2 — pure title-commit resolution shared by the TileHeader
 * and Frame inline title editors.
 *
 * Mirrors the blur-commit logic both components previously inlined: trim the
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
  /** Trimmed plain-text title; `fallback` when the user emptied the editor. */
  plain: string;
  /** Rich-text HTML, or undefined when it adds nothing over `plain`. */
  titleHtml: string | undefined;
}

export function resolveTitleCommitValues(
  rawText: string,
  html: string,
  fallback: string,
): ResolvedTitleCommit {
  const plain = rawText.trim() || fallback;
  const stripped = html.replace(/<\/?p[^>]*>/gi, '').trim();
  const isPlain = stripped === plain || stripped === '';
  return { plain, titleHtml: isPlain ? undefined : html };
}
