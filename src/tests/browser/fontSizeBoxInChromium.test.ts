import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { tiptapToolbar } from '../../renderer/lib/editor/toolbarConfig';
import { toolbarStore } from '../../renderer/stores/toolbar.svelte';

/**
 * The toolbar's font size box and its + / − buttons start from the size the
 * text is shown at. They started from 14 px whatever the text was: in a
 * Document (16 px text) + made the text smaller, in a heading + shrank it to
 * 15 px, in a 13 px tile − did nothing you could see, and text pasted in
 * points was read as pixels.
 */

const editors: Editor[] = [];
const styles: HTMLStyleElement[] = [];
afterEach(() => {
  while (editors.length) {
    const ed = editors.pop()!;
    tiptapToolbar.releaseEditor(ed);
    ed.destroy();
  }
  while (styles.length) styles.pop()!.remove();
  document.body.innerHTML = '';
});

/** An editor in a host whose text is `px` pixels, with headings at twice that. */
function editorAt(px: number, markdown: string): { ed: Editor; host: HTMLElement } {
  const style = document.createElement('style');
  style.textContent = `.size-host .tiptap { font-size: ${px}px; } .size-host .tiptap h1 { font-size: 2em; }`;
  document.head.appendChild(style);
  styles.push(style);
  const host = document.createElement('div');
  host.className = 'size-host';
  document.body.appendChild(host);
  const ed = createTiptapEditor({ element: host, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, markdown);
  return { ed, host };
}

/** Selects the first `word` in the note and makes the editor the toolbar's. */
async function selectWord(ed: Editor, word: string): Promise<void> {
  let at = -1;
  ed.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(word)) at = pos + node.text.indexOf(word);
    return at < 0;
  });
  if (at < 0) throw new Error(`no "${word}" in the note`);
  ed.commands.setTextSelection({ from: at, to: at + word.length });
  tiptapToolbar.setActiveEditor(ed);
  await settle();
}

/** The toolbar's store is written in a microtask after each transaction. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function shownSize(host: HTMLElement, word: string): number {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.textContent ?? '').includes(word)) return parseFloat(getComputedStyle(n.parentElement!).fontSize);
  }
  throw new Error(`no "${word}" shown`);
}

describe('the font size box shows the size the text is shown at', () => {
  it('16 px Document text: the box says 16, and + makes it 17 px', async () => {
    const { ed, host } = editorAt(16, 'Alpha beta gamma');
    await selectWord(ed, 'beta');
    expect(toolbarStore.fontSize).toBe(16);
    tiptapToolbar.increaseFontSize();
    // The app's editors report every transaction to the toolbar (`syncState`).
    tiptapToolbar.syncState();
    await settle();
    expect(shownSize(host, 'beta')).toBe(17);
    expect(toolbarStore.fontSize).toBe(17);
    expect(editorMarkdown(ed)).toBe('Alpha <span style="font-size: 17px;">beta</span> gamma');
  });

  it('a heading shown at 32 px: + makes it 33 px, not 15', async () => {
    const { ed, host } = editorAt(16, '# Chapter One');
    await selectWord(ed, 'Chapter');
    expect(toolbarStore.fontSize).toBe(32);
    tiptapToolbar.increaseFontSize();
    await settle();
    expect(shownSize(host, 'Chapter')).toBe(33);
  });

  it('13 px tile text: − makes it 12 px', async () => {
    const { ed, host } = editorAt(13, 'Alpha beta gamma');
    await selectWord(ed, 'beta');
    expect(toolbarStore.fontSize).toBe(13);
    tiptapToolbar.decreaseFontSize();
    await settle();
    expect(shownSize(host, 'beta')).toBe(12);
  });

  it('text sized in points reads as its size in pixels: 12 pt is 16 px, and + makes it 17 px', async () => {
    const { ed, host } = editorAt(16, 'Alpha <span style="font-size: 12pt">beta</span> gamma');
    await selectWord(ed, 'beta');
    expect(toolbarStore.fontSize).toBe(16);
    tiptapToolbar.increaseFontSize();
    await settle();
    expect(shownSize(host, 'beta')).toBe(17);
  });

  it('text with its own size in pixels shows that size', async () => {
    const { ed } = editorAt(16, 'Alpha <span style="font-size: 22px">beta</span> gamma');
    await selectWord(ed, 'beta');
    expect(toolbarStore.fontSize).toBe(22);
  });

  it('a caret takes the size of the text before it', async () => {
    const { ed } = editorAt(16, 'Alpha <span style="font-size: 22px">beta</span> gamma');
    await selectWord(ed, 'gamma');
    ed.commands.setTextSelection(ed.state.selection.from);
    tiptapToolbar.syncState();
    await settle();
    // Right after "beta ", in plain text.
    expect(toolbarStore.fontSize).toBe(16);
  });
});
