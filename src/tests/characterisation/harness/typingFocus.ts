/**
 * Typing as the keyboard does: each key goes to whatever has focus, and
 * bubbles to the window, where the app's shortcuts listen. A key nothing
 * takes (no `preventDefault`) types its character into the focused text: a
 * text editor, an input or a textarea. A key some shortcut took types
 * nothing, as in the browser.
 */
import type { Editor } from '@tiptap/core';
import { settle, type CharApp } from './app';
import { $ } from './actions';

function focused(): HTMLElement {
  return (document.activeElement as HTMLElement | null) ?? document.body;
}

function editorOf(el: HTMLElement): Editor | null {
  const pm = el.closest('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
  return pm?.editor ?? null;
}

function typeChar(ch: string): void {
  const target = focused();
  const down = new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  if (!down.defaultPrevented) {
    const ed = editorOf(target);
    if (ed) {
      const { from, to } = ed.state.selection;
      const handled = ed.view.someProp('handleTextInput', (f) => f(ed.view, from, to, ch, () => ed.state.tr.insertText(ch, from, to)));
      // Replaces the selection (a whole title selected included) and leaves the caret after it.
      if (!handled) ed.view.dispatch(ed.state.tr.insertText(ch));
    } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.value += ch;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  target.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true }));
}

/** Types `text` one key at a time into whatever has focus. */
export async function typeAtFocus(text: string): Promise<void> {
  for (const ch of text) {
    typeChar(ch);
    await settle(2);
  }
  await settle();
}

/** Presses one key (Enter, Escape…) where focus is. */
export async function pressAtFocus(k: string, init: KeyboardEventInit = {}): Promise<void> {
  const target = focused();
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  target.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true, ...init }));
  await settle();
}

/** Focus leaves every field and control: the page itself has it, as after a menu closes. */
export async function focusPage(): Promise<void> {
  (document.activeElement as HTMLElement | null)?.blur();
  await settle();
}

/** Focus the open board itself (a click on its empty space does this). */
export async function focusBoard(app: CharApp, kind: 'mindmap' | 'kanban'): Promise<void> {
  $(app.el, kind === 'mindmap' ? '.mindmap-board' : '.kanban-board').focus();
  await settle();
}

/** The placeholder an empty tile or card body shows, or null when it shows none. */
export function emptyBodyHint(tileRoot: HTMLElement): string | null {
  const p = tileRoot.querySelector('.tiptap p.is-editor-empty[data-placeholder]');
  return p?.getAttribute('data-placeholder') ?? null;
}
