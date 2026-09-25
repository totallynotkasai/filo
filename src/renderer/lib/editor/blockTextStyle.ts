import type { CommandProps } from '@tiptap/core';

/**
 * Chain command: removes the `textStyle` mark (inline font size, font family
 * and text colour) from every text block the selection touches, whole blocks
 * and not only the selected part. Run before a heading level or Normal text is
 * applied, so the level's own size shows: an inline font size (from the size
 * buttons, or pasted text) would otherwise override it.
 *
 * Bold, italic, underline, strike, code, highlight and links stay: they change
 * meaning or emphasis, not the size or look a heading level sets.
 *
 * Always returns true, so it never fails the chain it's in.
 */
export function clearBlockTextStyle({ tr }: CommandProps): boolean {
  const textStyle = tr.doc.type.schema.marks.textStyle;
  if (!textStyle) return true;
  const { from, to } = tr.selection;
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    tr.removeMark(pos + 1, pos + node.nodeSize - 1, textStyle);
    return false;
  });
  tr.removeStoredMark(textStyle);
  return true;
}
