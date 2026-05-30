import type { Editor } from '@tiptap/core';
import { toolbarStore } from '../../stores/toolbar.svelte';

/**
 * Tiptap ↔ GlobalToolbar bridge.
 * Tracks the active editor, syncs formatting state to the toolbar store,
 * and exposes command functions for toolbar buttons.
 */

let activeEditor: Editor | null = null;
let blurTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * The TextFormattingToolbar owns the LinkInsertPopup UI; it registers an
 * "open" callback here at mount so external surfaces (the Ctrl+K command in
 * AppShell) can trigger the same flow as the toolbar button. Null when no
 * toolbar is mounted.
 */
let openInsertLinkPopupImpl: ((anchor: { x: number; y: number }) => void) | null = null;

/**
 * Reads the current formatting state from this editor and pushes it to toolbarStore.
 *
 * The mutation is deferred via queueMicrotask so it never lands during a
 * `$derived` evaluation or template expression. Tiptap fires `onTransaction`
 * synchronously inside chain commands (e.g. `setLink().run()`); when the
 * originating call site is itself reactive, a synchronous `$state` write
 * here would throw `state_unsafe_mutation` and unwind the chain (which was
 * also why Insert Link silently dropped its setLink).
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

  const next = {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
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
  setActiveEditor(editor: Editor) {
    // Cancel any pending blur clear — the editor is refocused
    if (blurTimeout) {
      clearTimeout(blurTimeout);
      blurTimeout = null;
    }
    activeEditor = editor;
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
    activeEditor?.chain().focus().toggleBold().run();
  },

  toggleItalic() {
    this.keepActiveEditor();
    activeEditor?.chain().focus().toggleItalic().run();
  },

  toggleUnderline() {
    this.keepActiveEditor();
    activeEditor?.chain().focus().toggleUnderline().run();
  },

  setTextColor(color: string) {
    this.keepActiveEditor();
    if (!color) {
      activeEditor?.chain().focus().unsetColor().run();
    } else {
      activeEditor?.chain().focus().setColor(color).run();
    }
  },

  setHighlightColor(color: string) {
    this.keepActiveEditor();
    if (!color || color === 'transparent') {
      activeEditor?.chain().focus().unsetHighlight().run();
    } else {
      activeEditor?.chain().focus().setHighlight({ color }).run();
    }
  },

  setFontFamily(font: string) {
    this.keepActiveEditor();
    activeEditor?.chain().focus().setFontFamily(font).run();
  },

  setFontSize(size: number) {
    this.keepActiveEditor();
    activeEditor?.chain().focus().setMark('textStyle', { fontSize: `${size}px` }).run();
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
    activeEditor?.chain().focus().setTextAlign(align).run();
  },

  setHeading(level: 0 | 1 | 2 | 3 | 4 | 5 | 6) {
    this.keepActiveEditor();
    if (level === 0) {
      activeEditor?.chain().focus().setParagraph().run();
    } else {
      activeEditor?.chain().focus().setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run();
    }
  },

  toggleBulletList() {
    this.keepActiveEditor();
    activeEditor?.chain().focus().toggleBulletList().run();
  },

  toggleOrderedList() {
    this.keepActiveEditor();
    activeEditor?.chain().focus().toggleOrderedList().run();
  },

  toggleTaskList() {
    this.keepActiveEditor();
    activeEditor?.chain().focus().toggleTaskList().run();
  },

  increaseIndent() {
    this.keepActiveEditor();
    if (!activeEditor) return;
    if (activeEditor.isActive('listItem') || activeEditor.isActive('taskItem')) {
      activeEditor.chain().focus().sinkListItem('listItem').run();
    } else {
      activeEditor.chain().focus().increaseIndent().run();
    }
  },

  decreaseIndent() {
    this.keepActiveEditor();
    if (!activeEditor) return;
    if (activeEditor.isActive('listItem') || activeEditor.isActive('taskItem')) {
      activeEditor.chain().focus().liftListItem('listItem').run();
    } else {
      activeEditor.chain().focus().decreaseIndent().run();
    }
  },

  clearFormatting() {
    this.keepActiveEditor();
    activeEditor?.chain().focus().clearNodes().unsetAllMarks().run();
  },

  setLink(url: string) {
    if (url) {
      activeEditor?.chain().focus().setLink({ href: url }).run();
    } else {
      activeEditor?.chain().focus().unsetLink().run();
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
    activeEditor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  },

  toggleCodeBlock() {
    this.keepActiveEditor();
    activeEditor?.chain().focus().toggleCodeBlock().run();
  },

  setLineSpacing(value: number) {
    if (!activeEditor) return;
    const editorEl = activeEditor.view.dom as HTMLElement;
    editorEl.style.lineHeight = String(value);
    toolbarStore.setLineSpacing(value);
  },
};
