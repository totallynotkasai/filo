import type { Editor } from '@tiptap/core';
import { tiptapToolbar } from './toolbarConfig';
import { linkTargetAt } from './insertLink';
import { uiStore } from '../../stores/ui.svelte';

/**
 * The renderer's half of the right-click menu on text, which main builds
 * (`main/utils/textMenu.ts`). As the menu opens, main asks whether a link
 * can go at the caret: only in a note's text (a title or label has no link
 * mark, and the Raw view is plain text). The menu's Insert Link then opens
 * the same popup as Ctrl+K, on the editor the menu was opened over, where
 * the menu opened.
 */

export type TextMenuLink = 'insert' | 'edit' | 'none';

/** Where main says its menu opened, or undefined (the popup then opens at the caret). */
function asPoint(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/**
 * What the menu offers for `editor` (the toolbar's active one) with focus on
 * `focused`: Edit Link on a link, Insert Link elsewhere in an editable note,
 * nothing when the focus isn't in it.
 */
export function textMenuLink(editor: Editor | null, focused: Element | null): TextMenuLink {
  if (!editor || editor.isDestroyed || !editor.isEditable || !editor.schema.marks.link) return 'none';
  if (!focused || !editor.view.dom.contains(focused)) return 'none';
  return linkTargetAt(editor).href ? 'edit' : 'insert';
}

/**
 * Answers main's question and, when the menu's link item is picked, opens the
 * Insert Link popup on the editor the menu was opened over. Returns the
 * unsubscribe.
 */
export function installTextMenu(): () => void {
  // The editor the open menu was asked about; the native menu may have taken
  // the focus from it by the time an item is picked.
  let menuEditor: Editor | null = null;
  const offQuery = window.filo.on('app:text-menu-query', (id) => {
    const editor = tiptapToolbar.activeEditor;
    const link = textMenuLink(editor, document.activeElement);
    menuEditor = link === 'none' ? null : editor;
    if (typeof id === 'number') window.filo.send('app:text-menu-reply', id, { link });
  });
  const offInsert = window.filo.on('app:insert-link', (at) => {
    const editor = menuEditor;
    menuEditor = null;
    // `view.focus()`, not the focus command, which waits for an animation
    // frame: the popup needs the editor active now.
    if (editor && !editor.isDestroyed && tiptapToolbar.activeEditor !== editor) editor.view.focus();
    if (!tiptapToolbar.requestInsertLink(asPoint(at))) uiStore.toast('Click into a text tile or document first', 'info');
  });
  return () => {
    offQuery();
    offInsert();
  };
}
