import type { Editor } from '@tiptap/core';
import { toolbarStore } from '../../stores/toolbar.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { setNoteLineSpacing } from '../../stores/noteLayout';
import { clearBlockTextStyle } from './blockTextStyle';

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
  const next = {
    lineSpacingNote: note ? note.path : null,
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    link: editor.isActive('link'),
    textColor: editor.getAttributes('textStyle').color || '#ffffff',
    highlightColor: editor.getAttributes('highlight').color || 'transparent',
    fontFamily: editor.getAttributes('textStyle').fontFamily || 'Inter',
    fontSize: parseInt(editor.getAttributes('textStyle').fontSize) || 14,
    textAlign,
    heading,
  };

  queueMicrotask(() => toolbarStore.updateFromEditor(next));
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
    chainIfEditable()?.focus().setFontFamily(font).run();
  },

  setFontSize(size: number) {
    this.keepActiveEditor();
    chainIfEditable()?.focus().setMark('textStyle', { fontSize: `${size}px` }).run();
  },

  increaseFontSize() {
    const current = parseInt(activeEditor?.getAttributes('textStyle').fontSize) || 14;
    this.setFontSize(Math.min(current + 1, 72));
  },

  decreaseFontSize() {
    const current = parseInt(activeEditor?.getAttributes('textStyle').fontSize) || 14;
    this.setFontSize(Math.max(current - 1, 8));
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

  toggleBulletList() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().toggleBulletList().run();
  },

  toggleOrderedList() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().toggleOrderedList().run();
  },

  toggleTaskList() {
    this.keepActiveEditor();
    chainIfEditable()?.focus().toggleTaskList().run();
  },

  increaseIndent() {
    this.keepActiveEditor();
    if (!activeEditor) return;
    if (activeEditor.isActive('listItem') || activeEditor.isActive('taskItem')) {
      chainIfEditable()?.focus().sinkListItem('listItem').run();
    } else {
      chainIfEditable()?.focus().increaseIndent().run();
    }
  },

  decreaseIndent() {
    this.keepActiveEditor();
    if (!activeEditor) return;
    if (activeEditor.isActive('listItem') || activeEditor.isActive('taskItem')) {
      chainIfEditable()?.focus().liftListItem('listItem').run();
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
