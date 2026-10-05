import type { Editor } from '@tiptap/core';
import { toolbarStore } from '../../stores/toolbar.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { setNoteLineSpacing } from '../../stores/noteLayout';
import { clearBlockTextStyle } from './blockTextStyle';
import { fontFamilyValue } from '../../../shared/fontStack';

/** Shown when TipTap's Link URI allowlist refuses a link. */
export const LINK_REFUSED_MESSAGE = "That link couldn't be added. Use https://, mailto: or a filo:// link.";

/** Shown when the link's place takes no link, whatever its URL. */
export const LINK_IN_CODE_MESSAGE = "Links can't go in a code block.";

/**
 * Tiptap ↔ GlobalToolbar bridge.
 * Tracks the active editor, syncs formatting state to the toolbar store,
 * and exposes command functions for toolbar buttons.
 */

let activeEditor: Editor | null = null;

/**
 * The note an editor shows, for toolbar settings that belong to the whole note
 * (line spacing). A getter, so a rename or a tab switch is followed.
 */
export interface ActiveNote {
  /** The note's vault path. */
  path: string;
  /** The board or Document tab whose undo stack records the edit. */
  historyBoardId: string;
}
let activeNote: (() => ActiveNote | null) | null = null;
let blurTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * The TextFormattingToolbar owns the LinkInsertPopup UI; it registers an
 * "open" callback here at mount so external surfaces (the Ctrl+K command in
 * AppShell) can trigger the same flow as the toolbar button. Null when no
 * toolbar is mounted.
 */
let openInsertLinkPopupImpl: ((anchor: { x: number; y: number }) => void) | null = null;

/**
 * Every MUTATING toolbar command routes through here. A non-editable editor
 * (lossy read-only note, close-drain freeze, failed disk read) still accepts
 * TipTap commands programmatically, so without this a Bold / heading / list
 * button would change a read-only note's text anyway.
 */
function chainIfEditable(): ReturnType<Editor['chain']> | null {
  if (!activeEditor || !activeEditor.isEditable) return null;
  return activeEditor.chain();
}

/** The size box's value when the editor shows nothing it can measure. */
const FALLBACK_FONT_SIZE = 14;

/** CSS pixels in a point (text pasted from Word or Google Docs is sized in points). */
const PX_PER_PT = 4 / 3;

/** A font size mark's value in whole pixels, or null for a unit only the page can resolve. */
function fontSizeInPx(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px|pt)?\s*$/i.exec(value);
  if (!m) return null;
  const n = parseFloat(m[1] ?? '');
  const px = m[2]?.toLowerCase() === 'pt' ? n * PX_PER_PT : n;
  return px > 0 ? Math.round(px) : null;
}

/**
 * The size the selected text is shown at, in whole pixels: its own size
 * mark, else the size the page draws it at (a Document's 16 px body, a
 * heading's 2em). The size box shows it and + / − step from it, so + never
 * shrinks text the page shows larger than the box's fallback.
 */
function shownFontSize(editor: Editor): number {
  const own = fontSizeInPx(editor.getAttributes('textStyle').fontSize);
  if (own !== null) return own;
  try {
    const { selection } = editor.state;
    // The caret takes the style of the text before it; a selection, of its first character.
    const { node } = editor.view.domAtPos(selection.from, selection.empty ? -1 : 1);
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node instanceof Element ? node : null;
    const px = el ? parseFloat(getComputedStyle(el).fontSize) : NaN;
    if (px > 0) return Math.round(px);
  } catch {
    // A view not yet mounted has no DOM to measure.
  }
  return FALLBACK_FONT_SIZE;
}

/**
 * Reads the current formatting state from this editor and pushes it to toolbarStore.
 *
 * The mutation is deferred via queueMicrotask so it never lands during a
 * `$derived` evaluation or template expression. Tiptap fires `onTransaction`
 * synchronously inside chain commands (e.g. `setLink().run()`); when the
 * originating call site is itself reactive, a synchronous `$state` write
 * here would throw `state_unsafe_mutation` and unwind the chain (e.g. Insert
 * Link silently dropping its setLink).
 */
function syncStateToToolbar(editor: Editor) {
  const heading: 'normal' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' =
      editor.isActive('heading', { level: 1 }) ? 'h1'
    : editor.isActive('heading', { level: 2 }) ? 'h2'
    : editor.isActive('heading', { level: 3 }) ? 'h3'
    : editor.isActive('heading', { level: 4 }) ? 'h4'
    : editor.isActive('heading', { level: 5 }) ? 'h5'
    : editor.isActive('heading', { level: 6 }) ? 'h6'
    : 'normal';

  const textAlign = (editor.isActive({ textAlign: 'center' }) ? 'center'
    : editor.isActive({ textAlign: 'right' }) ? 'right'
    : editor.isActive({ textAlign: 'justify' }) ? 'justify'
    : 'left') as 'left' | 'center' | 'right' | 'justify';

  const note = activeNote?.() ?? null;
  // Align fails where nothing can be aligned: a list item (`listItemLayout.ts`),
  // code, or an editor without alignment (a connection label).
  const can = editor.can();
  const alignAvailable = 'setTextAlign' in can && can.setTextAlign('left');
  const next = {
    alignAvailable,
    alignInList: !alignAvailable && listItemAround(editor) !== null,
    // Titles and connection labels hold no lists.
    listsAvailable: 'switchList' in can,
    lineSpacingNote: note ? note.path : null,
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    link: editor.isActive('link'),
    textColor: editor.getAttributes('textStyle').color || '#ffffff',
    highlightColor: editor.getAttributes('highlight').color || 'transparent',
    fontFamily: editor.getAttributes('textStyle').fontFamily || '',
    fontSize: shownFontSize(editor),
    textAlign,
    heading,
    editorHistory: {
      canUndo: editor.isEditable && editor.can().undo(),
      canRedo: editor.isEditable && editor.can().redo(),
    },
  };

  queueMicrotask(() => toolbarStore.updateFromEditor(next));
}

/** The kind of list item the caret is in (the innermost), or null outside lists. */
function listItemAround(editor: Editor): 'listItem' | 'taskItem' | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'listItem' || name === 'taskItem') return name;
  }
  return null;
}

export const tiptapToolbar = {
  get activeEditor() { return activeEditor; },

  /**
   * Registers an editor as the active one (called on focus).
   */
  setActiveEditor(editor: Editor, note?: () => ActiveNote | null) {
    // Cancel any pending blur clear — the editor is refocused
    if (blurTimeout) {
      clearTimeout(blurTimeout);
      blurTimeout = null;
    }
    activeEditor = editor;
    activeNote = note ?? null;
    syncStateToToolbar(editor);
  },

  /**
   * Clears the active editor (called on blur).
   * Uses a short delay so toolbar button clicks can fire before the editor is cleared.
   */
  clearActiveEditor() {
    if (blurTimeout) clearTimeout(blurTimeout);
    blurTimeout = setTimeout(() => {
      activeEditor = null;
      activeNote = null;
      toolbarStore.reset();
      blurTimeout = null;
    }, 300);
  },

  /**
   * Drops `editor` at once when its view is torn down, unlike the blur's
   * delayed clear. The view's note callback reads the view's own state,
   * which is gone once it is destroyed, and a destroyed editor must not keep
   * driving the toolbar. No-op when another editor is active.
   */
  releaseEditor(editor: Editor) {
    if (activeEditor !== editor) return;
    if (blurTimeout) {
      clearTimeout(blurTimeout);
      blurTimeout = null;
    }
    activeEditor = null;
    activeNote = null;
    toolbarStore.reset();
  },

  /**
   * Cancels any pending blur clear (call when a toolbar control receives focus).
   * Prevents the 150ms timeout from nulling activeEditor before onchange fires —
   * needed for <select> dropdowns where the user may take longer than 150ms to pick an option.
   */
  keepActiveEditor() {
    if (blurTimeout) {
      clearTimeout(blurTimeout);
      blurTimeout = null;
    }
  },

  /**
   * Syncs the current editor state to toolbar (call on selectionUpdate/transaction).
   */
  syncState() {
    if (activeEditor) syncStateToToolbar(activeEditor);
  },

  // ── Command functions called by GlobalToolbar buttons ──

  /**
   * The toolbar's Undo / Redo while a text editor is focused: the editor's
   * own history, as Ctrl+Z does there (board undo runs only with no editor
   * focused). Returns false with no editor focused, for the board's undo.
   */
  undoInEditor(): boolean {
    if (!activeEditor) return false;
    this.keepActiveEditor();
    chainIfEditable()?.focus().undo().run();
    return true;
  },

  redoInEditor(): boolean {
    if (!activeEditor) return false;
    this.keepActiveEditor();
    chainIfEditable()?.focus().redo().run();
    return true;
  },

  toggleBold() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().toggleBold().run();
  },

  toggleItalic() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().toggleItalic().run();
  },

  toggleUnderline() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().toggleUnderline().run();
  },

  setTextColor(color: string) {
    this.keepActiveEditor();
    if (!color) {
      chainIfEditable()?.focus().unsetColor().run();
    } else {
      chainIfEditable()?.focus().setColor(color).run();
    }
  },

  setHighlightColor(color: string) {
    this.keepActiveEditor();
    if (!color || color === 'transparent') {
      chainIfEditable()?.focus().unsetHighlight().run();
    } else {
      chainIfEditable()?.focus().setHighlight({ color }).run();
    }
  },

  setFontFamily(font: string) {
    this.keepActiveEditor();
    chainIfEditable()?.focus().setFontFamily(fontFamilyValue(font)).run();
  },

  setFontSize(size: number) {
    this.keepActiveEditor();
    chainIfEditable()?.focus().setMark('textStyle', { fontSize: `${size}px` }).run();
  },

  increaseFontSize() {
    if (!activeEditor) return;
    this.setFontSize(Math.min(shownFontSize(activeEditor) + 1, 72));
  },

  decreaseFontSize() {
    if (!activeEditor) return;
    this.setFontSize(Math.max(shownFontSize(activeEditor) - 1, 8));
  },

  setTextAlign(align: 'left' | 'center' | 'right' | 'justify') {
    this.keepActiveEditor();
    chainIfEditable()?.focus().setTextAlign(align).run();
  },

  /**
   * A heading level (or Normal text, 0) also clears the blocks' font size,
   * family and colour, so the level's own size shows: an inline font size
   * would otherwise override it.
   *
   * Returns false when nothing changed (no editor, a read-only note, a title
   * or label editor, or a block that can't become a heading), so the dropdown
   * can put back the level the block really has.
   */
  setHeading(level: 0 | 1 | 2 | 3 | 4 | 5 | 6): boolean {
    this.keepActiveEditor();
    // Title and label editors have no headings (nor a setHeading command).
    if (!activeEditor?.schema.nodes.heading) return false;
    const chain = chainIfEditable()?.focus().command(clearBlockTextStyle);
    if (!chain) return false;
    return level === 0 ? chain.setParagraph().run() : chain.setHeading({ level }).run();
  },

  // The lists the selection reaches change kind in place (`listSwitch.ts`).
  toggleBulletList() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().switchList('bulletList').run();
  },

  toggleOrderedList() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().switchList('orderedList').run();
  },

  toggleTaskList() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().switchList('taskList').run();
  },

  /** In a list, Indent nests the item (a list level in the file), as Tab does; elsewhere it indents the text. */
  increaseIndent() {
    this.keepActiveEditor();
    if (!activeEditor) return;
    const item = listItemAround(activeEditor);
    if (item) {
      chainIfEditable()?.focus().sinkListItem(item).run();
    } else {
      chainIfEditable()?.focus().increaseIndent().run();
    }
  },

  decreaseIndent() {
    this.keepActiveEditor();
    if (!activeEditor) return;
    const item = listItemAround(activeEditor);
    if (item) {
      chainIfEditable()?.focus().liftListItem(item).run();
    } else {
      chainIfEditable()?.focus().decreaseIndent().run();
    }
  },

  clearFormatting() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().clearNodes().unsetAllMarks().run();
  },

  setLink(url: string) {
    if (url) {
      // setLink returns false when Link's URI allowlist refuses the href;
      // surface it rather than failing silently.
      const ok = chainIfEditable()?.focus().setLink({ href: url }).run();
      if (activeEditor?.isEditable && !ok) uiStore.toast(LINK_REFUSED_MESSAGE, 'error');
    } else {
      chainIfEditable()?.focus().unsetLink().run();
    }
  },

  /**
   * Registers the TextFormattingToolbar's "open Insert Link popup" handler.
   * Called with `null` on toolbar unmount.
   */
  setOpenInsertLinkPopup(fn: ((anchor: { x: number; y: number }) => void) | null) {
    openInsertLinkPopupImpl = fn;
  },

  /**
   * Opens the Insert Link popup. When invoked without an anchor (e.g. from a
   * keyboard shortcut), positions the popup at the editor caret. Returns
   * true if the popup was opened, false otherwise (no active editor or no
   * toolbar mounted).
   */
  requestInsertLink(anchor?: { x: number; y: number }): boolean {
    if (!openInsertLinkPopupImpl) return false;
    let resolved = anchor;
    if (!resolved) {
      if (!activeEditor) return false;
      try {
        const coords = activeEditor.view.coordsAtPos(activeEditor.state.selection.from);
        resolved = { x: coords.left, y: coords.bottom + 4 };
      } catch {
        return false;
      }
    }
    openInsertLinkPopupImpl(resolved);
    return true;
  },

  insertTable() {
    chainIfEditable()?.focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  },

  toggleCodeBlock() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().toggleCodeBlock().run();
  },

  /**
   * Line spacing belongs to the whole note: it is saved in the note's
   * frontmatter (`lineSpacing:`), and every view of the note shows it.
   * `null` removes it, so the note follows Settings → General's default.
   * Editors that don't show a note (connection labels, titles) have none.
   */
  setLineSpacing(value: number | null) {
    this.keepActiveEditor();
    const note = activeNote?.();
    if (!note || !activeEditor?.isEditable) return;
    setNoteLineSpacing(note.historyBoardId, note.path, value);
    activeEditor.commands.focus();
  },
};
