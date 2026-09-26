import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import TextFormattingToolbar from '@renderer/components/layout/TextFormattingToolbar.svelte';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import { LINK_IN_CODE_MESSAGE, LINK_REFUSED_MESSAGE } from '@renderer/lib/editor/toolbarConfig';
import {
  recordingFilo,
  mountTextTile,
  settle,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
  type Mounted,
} from './helpers/mountEditor';

/**
 * Insert Link through the real UI: a mounted TextTile, the real formatting
 * toolbar's link button, typing into the popup, Enter, and the saved `.md`.
 * The earlier round-trip test called the editor's `setLink` directly, so a
 * broken popup path (a bare caret inserting nothing, a scheme-less URL saved
 * dead) never showed.
 */
describe('Insert Link from the toolbar', () => {
  let toolbar: Record<string, unknown> | null = null;

  beforeEach(() => resetEditorHarness());
  afterEach(async () => {
    if (toolbar) await unmount(toolbar);
    toolbar = null;
    teardownEditorHarness();
  });

  async function setUp(body: string): Promise<{ m: Mounted; files: Map<string, string> }> {
    const fs = recordingFilo({ 'Note.md': body });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    toolbar = mount(TextFormattingToolbar, { target: bar }) as Record<string, unknown>;
    m.editor().commands.focus();
    await settle();
    expect(tiptapToolbar.activeEditor).toBe(m.editor());
    return { m, files: fs.files };
  }

  function linkButton(): HTMLButtonElement {
    const btn = document.querySelector<HTMLButtonElement>('button[title$="Link (Ctrl+K)"]');
    if (!btn) throw new Error('no link button');
    return btn;
  }

  async function openPopup(): Promise<{ popup: HTMLElement; text: HTMLInputElement; url: HTMLInputElement }> {
    const btn = linkButton();
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    btn.click();
    await settle();
    const popup = document.querySelector<HTMLElement>('.link-popup');
    if (!popup) throw new Error('link popup did not open');
    const [text, url] = Array.from(popup.querySelectorAll('input'));
    return { popup, text, url };
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pressEnter(input: HTMLInputElement): void {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }

  it('links the selected text, adding https:// to a bare domain', async () => {
    const { m, files } = await setUp('Alpha beta gamma\n');
    m.editor().commands.setTextSelection({ from: 7, to: 11 });
    const { text, url } = await openPopup();
    expect(text.value).toBe('beta');
    type(url, 'example.com');
    pressEnter(url);
    await drainDebounce();
    expect(document.querySelector('.link-popup')).toBeNull();
    expect(files.get('Note.md')).toBe('Alpha [beta](https://example.com) gamma\n');
  });

  it('inserts a new link at a bare caret', async () => {
    const { m, files } = await setUp('Alpha beta gamma\n');
    m.editor().commands.setTextSelection(17);
    const { text, url } = await openPopup();
    expect(text.value).toBe('');
    type(text, ' the site');
    type(url, 'https://example.com');
    pressEnter(url);
    await drainDebounce();
    expect(files.get('Note.md')).toBe('Alpha beta gamma[ the site](https://example.com)\n');
  });

  it('edits an existing link from a caret inside it', async () => {
    const { m, files } = await setUp('See [old](https://old.example) now\n');
    m.editor().commands.setTextSelection(7);
    await settle();
    expect(linkButton().getAttribute('aria-pressed')).toBe('true');
    const { popup, text, url } = await openPopup();
    expect(text.value).toBe('old');
    expect(url.value).toBe('https://old.example');
    expect(popup.textContent).toContain('Remove');
    type(text, 'new');
    type(url, 'https://new.example');
    pressEnter(text);
    await drainDebounce();
    expect(files.get('Note.md')).toBe('See [new](https://new.example) now\n');
  });

  it('keeps the popup open with an error for a refused URL, and writes nothing', async () => {
    const { m, files } = await setUp('Alpha beta gamma\n');
    m.editor().commands.setTextSelection({ from: 7, to: 11 });
    const { popup, url } = await openPopup();
    type(url, 'javascript:alert(1)');
    pressEnter(url);
    await drainDebounce();
    expect(document.querySelector('.link-popup')).toBe(popup);
    expect(popup.querySelector('[role="alert"]')?.textContent).toBe(LINK_REFUSED_MESSAGE);
    expect(files.get('Note.md')).toBe('Alpha beta gamma\n');
  });

  it('refuses a scheme a click would not open (ftp:), and writes nothing', async () => {
    const { m, files } = await setUp('Alpha beta gamma\n');
    m.editor().commands.setTextSelection({ from: 7, to: 11 });
    const { popup, url } = await openPopup();
    type(url, 'ftp://files.example.com');
    pressEnter(url);
    await drainDebounce();
    expect(document.querySelector('.link-popup')).toBe(popup);
    expect(popup.querySelector('[role="alert"]')?.textContent).toBe(LINK_REFUSED_MESSAGE);
    expect(files.get('Note.md')).toBe('Alpha beta gamma\n');
  });

  it('says a link cannot go in a code block, not that the URL is wrong', async () => {
    const { m, files } = await setUp('```\ncode here\n```\n');
    m.editor().commands.setTextSelection({ from: 1, to: 5 });
    const { popup, url } = await openPopup();
    type(url, 'https://example.com');
    pressEnter(url);
    await drainDebounce();
    expect(document.querySelector('.link-popup')).toBe(popup);
    expect(popup.querySelector('[role="alert"]')?.textContent).toBe(LINK_IN_CODE_MESSAGE);
    expect(files.get('Note.md')).toBe('```\ncode here\n```\n');
  });

  it('a caret right before a link inserts a new link and leaves that one alone', async () => {
    const { m, files } = await setUp('See [old](https://old.example) now\n');
    m.editor().commands.setTextSelection(5);
    const { popup, text, url } = await openPopup();
    expect(text.value).toBe('');
    expect(url.value).toBe('');
    expect(popup.textContent).not.toContain('Remove');
    type(text, 'new');
    type(url, 'https://new.example');
    pressEnter(url);
    await drainDebounce();
    expect(files.get('Note.md')).toBe('See [new](https://new.example)[old](https://old.example) now\n');
  });

  it("Enter and Escape don't reach window key handlers (a board's Enter renames the selected tile)", async () => {
    const { m } = await setUp('Alpha beta gamma\n');
    const seen: string[] = [];
    const onWindowKey = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    window.addEventListener('keydown', onWindowKey);
    try {
      m.editor().commands.setTextSelection({ from: 7, to: 11 });
      const first = await openPopup();
      type(first.url, 'example.com');
      pressEnter(first.url);
      await settle();
      const second = await openPopup();
      second.url.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await settle();
      expect(document.querySelector('.link-popup')).toBeNull();
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('renders the popup on <body>, outside the toolbar', async () => {
    const { m } = await setUp('Alpha beta gamma\n');
    m.editor().commands.setTextSelection({ from: 7, to: 11 });
    const { popup } = await openPopup();
    expect(popup.closest('.toolbar-section')).toBeNull();
    expect(popup.parentElement?.parentElement).toBe(document.body);
  });
});
