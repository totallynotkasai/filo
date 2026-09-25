import { getMarkRange, type Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

/**
 * What the Insert Link popup edits, captured when it opens: the popup's inputs
 * take focus, and the editor's selection can't be read back from them.
 */
export interface LinkTarget {
  from: number;
  to: number;
  /** The text in the range; pre-fills the popup's Text field. */
  text: string;
  /** The href of the link being edited, or '' for a new link. */
  href: string;
}

/**
 * The popup's target at the editor's selection. A caret inside a link, or a
 * selection within one, targets the whole link so it can be edited. Any other
 * selection is the text to link; a bare caret is where a new link goes.
 */
export function linkTargetAt(editor: Editor): LinkTarget {
  const { state } = editor;
  const { from, to } = state.selection;
  const linkType = state.schema.marks.link;
  const range = linkType ? getMarkRange(state.doc.resolve(from), linkType) : undefined;
  if (range && range.from <= from && to <= range.to) {
    const href: unknown = state.doc.nodeAt(range.from)?.marks.find((m) => m.type === linkType)?.attrs.href;
    return {
      from: range.from,
      to: range.to,
      text: state.doc.textBetween(range.from, range.to, ' '),
      href: typeof href === 'string' ? href : '',
    };
  }
  const href = editor.getAttributes('link').href;
  return {
    from,
    to,
    text: state.doc.textBetween(from, to, ' '),
    href: typeof href === 'string' ? href : '',
  };
}

/**
 * Makes `target` a link to `href`, showing `text`.
 *
 * - Text unchanged (or left empty) over a range: the range's own text and
 *   formatting stay, and only the link is set.
 * - New text: the range is replaced by it as one linked run.
 * - A bare caret: inserts the text, or the URL when Text is empty, as a new
 *   link. `setLink` alone would only set a stored mark there, inserting
 *   nothing.
 *
 * Returns false, changing nothing, when the editor is read-only or refuses the
 * href (Link's URI allowlist turns down `javascript:` and the like).
 */
export function applyLink(editor: Editor, target: LinkTarget, text: string, href: string): boolean {
  // A title or label editor has no link mark, and no setLink command at all.
  if (!editor.isEditable || !editor.schema.marks.link || !editor.can().setLink({ href })) return false;
  const { from, to } = clamped(editor, target);
  const current = editor.state.doc.textBetween(from, to, ' ');
  if (to > from && (text === '' || text === current)) {
    return editor.chain().focus().setTextSelection({ from, to }).setLink({ href }).run();
  }
  return editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, { type: 'text', text: text || href, marks: [{ type: 'link', attrs: { href } }] })
    // Links are inclusive at their end, so what is typed next would join the
    // new link.
    .unsetMark('link')
    .run();
}

/** Removes the link from `target`, keeping its text. */
export function removeLink(editor: Editor, target: LinkTarget): boolean {
  if (!editor.isEditable) return false;
  const { from, to } = clamped(editor, target);
  return editor.chain().focus().setTextSelection({ from, to }).extendMarkRange('link').unsetLink().run();
}

/**
 * The target kept inside the document's text: the document can change while
 * the popup is open (a reload from disk), and a position past the last text
 * block would insert a new paragraph.
 */
function clamped(editor: Editor, target: LinkTarget): { from: number; to: number } {
  const end = TextSelection.atEnd(editor.state.doc).from;
  const from = Math.min(target.from, end);
  return { from, to: Math.min(Math.max(target.to, from), end) };
}
