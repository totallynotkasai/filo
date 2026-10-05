/**
 * The formatting toolbar with no editor to act on, and the renderer's half of
 * the right-click menu on text, through the real toolbar and a real tile.
 *
 * - H-10: with no editor focused the font, size and B / I / U controls looked
 *   live and did nothing. They now show disabled; Spelling, a setting for
 *   every editor, stays.
 * - E-04: main asks, as its menu opens, whether a link can go at the caret;
 *   the menu's Insert Link opens the same popup as Ctrl+K.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import TextFormattingToolbar from '@renderer/components/layout/TextFormattingToolbar.svelte';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import { installTextMenu } from '@renderer/lib/editor/textMenu';
import {
  recordingFilo,
  mountTextTile,
  settle,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

let toolbar: Record<string, unknown> | null = null;

beforeEach(() => resetEditorHarness());
afterEach(async () => {
  if (toolbar) await unmount(toolbar);
  toolbar = null;
  teardownEditorHarness();
});

function mountToolbar(): void {
  const bar = document.createElement('div');
  document.body.appendChild(bar);
  toolbar = mount(TextFormattingToolbar, { target: bar }) as Record<string, unknown>;
}

function control(selector: string): HTMLButtonElement | HTMLSelectElement {
  const el = document.querySelector<HTMLButtonElement | HTMLSelectElement>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
}

const FORMATTING = [
  'select[aria-label="Font family"]',
  'button[aria-label="Increase font size"]',
  'button[title="Bold (Ctrl+B)"]',
  'button[title="Italic (Ctrl+I)"]',
  'button[aria-label="Text color"]',
  'select[aria-label="Text style"]',
  'button[title="Insert Link (Ctrl+K)"]',
  'select[aria-label="Text alignment"]',
  'button[title="Bulleted List"]',
  'button[title="Clear Formatting"]',
];

describe('the formatting toolbar with no editor', () => {
  it('shows its formatting controls disabled until an editor has the focus, and again after', async () => {
    recordingFilo({ 'Note.md': 'Alpha\n' });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    mountToolbar();
    await settle();

    for (const sel of FORMATTING) expect(control(sel).disabled, sel).toBe(true);
    expect(control('button[title="Spelling & Grammar"]').disabled).toBe(false);
    expect(document.querySelector('.toolbar-section.formatting')?.getAttribute('title')).toMatch(/Click into a note/);

    m.editor().commands.focus();
    await settle();
    for (const sel of FORMATTING) expect(control(sel).disabled, sel).toBe(false);

    m.editor().commands.blur();
    await new Promise((r) => setTimeout(r, 350)); // the toolbar lets the editor go 300 ms after a blur
    await settle();
    for (const sel of FORMATTING) expect(control(sel).disabled, sel).toBe(true);
  });

  it('keeps the editor while the focus moves into the toolbar, so its controls can be reached with Tab', async () => {
    recordingFilo({ 'Note.md': 'Alpha\n' });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    mountToolbar();
    m.editor().commands.focus();
    await settle();
    const bold = control('button[title="Bold (Ctrl+B)"]');
    bold.focus();
    await new Promise((r) => setTimeout(r, 350));
    await settle();
    expect(tiptapToolbar.activeEditor).toBe(m.editor());
    expect(bold.disabled).toBe(false);

    // Leaving the toolbar for the page lets the editor go.
    bold.blur();
    bold.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await new Promise((r) => setTimeout(r, 350));
    await settle();
    expect(tiptapToolbar.activeEditor).toBeNull();
  });
});

describe('the right-click menu on text', () => {
  /** window.filo's `on` and `send`, captured for main's side of the conversation. */
  function mainSide(): { emit: (channel: string, ...args: unknown[]) => void; sent: unknown[][] } {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const sent: unknown[][] = [];
    const filo = window.filo as unknown as Record<string, unknown>;
    filo.on = (channel: string, cb: (...args: unknown[]) => void) => {
      listeners.set(channel, cb);
      return () => listeners.delete(channel);
    };
    filo.send = (...args: unknown[]) => { sent.push(args); };
    return { emit: (channel, ...args) => listeners.get(channel)?.(...args), sent };
  }

  it('answers Insert Link in a note, Edit Link on a link, and nothing elsewhere', async () => {
    recordingFilo({ 'Note.md': 'Alpha [beta](https://example.com) gamma\n' });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    const main = mainSide();
    const stop = installTextMenu();
    try {
      main.emit('app:text-menu-query', 1);
      expect(main.sent.at(-1)).toEqual(['app:text-menu-reply', 1, { link: 'none' }]);

      m.editor().commands.focus();
      m.editor().commands.setTextSelection(2);
      await settle();
      main.emit('app:text-menu-query', 2);
      expect(main.sent.at(-1)).toEqual(['app:text-menu-reply', 2, { link: 'insert' }]);

      m.editor().commands.setTextSelection(10);
      await settle();
      main.emit('app:text-menu-query', 3);
      expect(main.sent.at(-1)).toEqual(['app:text-menu-reply', 3, { link: 'edit' }]);
    } finally {
      stop();
    }
  });

  it("opens the Insert Link popup on the editor the menu was opened over, even after it lost the focus", async () => {
    recordingFilo({ 'Note.md': 'Alpha beta\n' });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    mountToolbar();
    const main = mainSide();
    const stop = installTextMenu();
    try {
      m.editor().commands.focus();
      m.editor().commands.setTextSelection({ from: 7, to: 11 });
      await settle();
      main.emit('app:text-menu-query', 1);
      // The native menu takes the window's attention while it is open.
      m.editor().commands.blur();
      await new Promise((r) => setTimeout(r, 350));
      await settle();
      main.emit('app:insert-link', { x: 40, y: 60 });
      await settle();
      const popup = document.querySelector('.link-popup');
      expect(popup).not.toBeNull();
      expect((popup?.querySelector('input') as HTMLInputElement | null)?.value).toBe('beta');
    } finally {
      stop();
    }
  });
});
