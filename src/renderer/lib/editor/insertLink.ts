import { getMarkRange, type Editor, type Range } from '@tiptap/core';
import type { MarkType } from '@tiptap/pm/model';
import { TextSelection, type EditorState } from '@tiptap/pm/state';

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
 * The popup's target at the editor's selection. A caret inside a link or right
 * after one, or a selection within one, targets the whole link so it can be
 * edited. Any other selection is the text to link; any other bare caret
 * (including one right before a link) is where a new link goes.
 */
export function linkTargetAt(editor: Editor): LinkTarget {
  const { state } = editor;
  const { from, to } = state.selection;
  const linkType = state.schema.marks.link;
  const range = linkType ? linkRangeAt(state, from, to, linkType) : undefined;
  if (range) {
    const href: unknown = state.doc.nodeAt(range.from)?.marks.find((m) => m.type === linkType)?.attrs.href;
    return {
      from: range.from,
      to: range.to,
      text: state.doc.textBetween(range.from, range.to, ' '),
      href: typeof href === 'string' ? href : '',
    };
  }
  // A bare caret here starts a new link, even where the caret's marks read as
  // the link that begins right after it.
  const href = from === to ? '' : editor.getAttributes('link').href;
  return {
    from,
    to,
    text: state.doc.textBetween(from, to, ' '),
    href: typeof href === 'string' ? href : '',
  };
}

/**
 * The link the selection edits, if any. `getMarkRange` alone also matches a
 * caret right before a link (it looks at the text after the caret first), so
 * a new link typed there would replace the next one instead.
 */
function linkRangeAt(state: EditorState, from: number, to: number, linkType: MarkType): Range | undefined {
  if (from === to) {
    const before = state.doc.resolve(from).nodeBefore;
    if (!before || !linkType.isInSet(before.marks)) return undefined;
    // One step back lands inside the text before the caret, so the range is
    // that link's, not a neighbouring one's.
    return getMarkRange(state.doc.resolve(from - 1), linkType) ?? undefined;
  }
  const range = getMarkRange(state.doc.resolve(from), linkType);
  return range && range.from <= from && to <= range.to ? range : undefined;
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
 * Returns false, changing nothing, when the editor is read-only, the target
 * takes no link (`linkAllowedAt`), or the editor refuses the href (Link's URI
 * allowlist turns down `javascript:` and the like).
 */
export function applyLink(editor: Editor, target: LinkTarget, text: string, href: string): boolean {
  if (!linkAllowedAt(editor, target)) return false;
  const { from, to } = clamped(editor, target);
  if (!canAt(editor, { from, to }).setLink({ href }).run()) return false;
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

/**
 * True when a link can go at `target`, whatever its href: not in a code block
 * (which takes no marks) or inline code (which excludes them). Checked at the
 * target, not the editor's current selection, which can move while the popup
 * is open. Kept apart from the href check so the popup can say which of the
 * two is wrong.
 */
export function linkAllowedAt(editor: Editor, target: LinkTarget): boolean {
  // A title or label editor has no link mark, and no setLink command at all.
  if (!editor.isEditable || !editor.schema.marks.link) return false;
  // `setMark`, not `setLink`: the placement alone, without Link's URI check.
  return canAt(editor, clamped(editor, target)).setMark('link').run();
}

/**
 * A dry-run chain whose selection is `range`. `setTextSelection` does nothing
 * in a dry run, so the selection is set on the throwaway transaction directly;
 * the mark commands then check the target instead of the editor's selection.
 */
function canAt(editor: Editor, range: { from: number; to: number }): ReturnType<Editor['chain']> {
  return editor
    .can()
    .chain()
    .command(({ tr }) => {
      tr.setSelection(TextSelection.create(tr.doc, range.from, range.to));
      return true;
    });
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
