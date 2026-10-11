import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import '../../css/style.css';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { attachPageView, currentPageBreaks, measureWaits, type PageView } from '../../renderer/lib/editor/pageBreaks';
import type { PageBreak } from '../../renderer/lib/editor/pageLayout';

/**
 * Typing in a very long note with pages on. Each measure
 * looked every block up by position, a scan of the blocks before it, read
 * every block after every edit and built every break again: in a
 * 100,000-word note (5,000 paragraphs) the measures kept the page busy 1.8 s
 * of every 4 s of typing, with pauses up to 80 ms. A measure now reads only
 * the blocks an edit changed (the rest move with it), stands down when typing
 * inside a paragraph left the height alone, and swaps only the breaks that
 * changed; a long note's measure also waits for a longer pause.
 */

const RULES = `
  .page-column { width: 812px; padding: 56px 72px; box-sizing: border-box; position: relative; }
  .page-column .tiptap { font-size: 16px; line-height: 1.5; }
  .page-column .tiptap p { margin-top: 0; margin-bottom: 1.25em; }
  .page-column .tiptap p:has(+ p) { margin-bottom: 0; }
  .page-column .tiptap .filo-page-break { padding-top: var(--filo-page-break, 0px); }
`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.body.innerHTML = '';
});

/** `paragraphs` paragraphs of 20 words. */
function longNote(paragraphs: number): string {
  const out: string[] = [];
  for (let i = 0; i < paragraphs; i++) {
    const words: string[] = [];
    for (let w = 0; w < 20; w++) words.push(`word${(i * 7 + w) % 97}`);
    out.push(`${words.join(' ')}.`);
  }
  return out.join('\n\n');
}

interface Timed {
  ed: Editor;
  view: PageView;
  /** How long each timer callback ran (the measures run in one), ms. */
  timings: number[];
  wait(ms: number): Promise<void>;
}

/** A long note in a page column, with every timer callback timed. */
function pagedLongNote(paragraphs: number): Timed {
  const style = document.createElement('style');
  style.textContent = RULES;
  document.head.appendChild(style);
  const column = document.createElement('div');
  column.className = 'page-column';
  const host = document.createElement('div');
  column.appendChild(host);
  document.body.appendChild(column);

  const timings: number[] = [];
  const realSetTimeout = window.setTimeout;
  (window as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) =>
    realSetTimeout(() => {
      const t0 = performance.now();
      fn();
      timings.push(performance.now() - t0);
    }, ms)) as typeof setTimeout;

  const ed = createTiptapEditor({ element: host, content: '' });
  loadMarkdownIntoEditor(ed, longNote(paragraphs));
  const view = attachPageView(ed, { column: () => column, observed: () => [], onPages: () => {} });
  view.setEnabled(true);
  cleanups.push(() => {
    view.destroy();
    ed.destroy();
    (window as { setTimeout: unknown }).setTimeout = realSetTimeout;
    style.remove();
  });
  return { ed, view, timings, wait: (ms) => new Promise((r) => realSetTimeout(r, ms)) };
}

function breaks(ed: Editor): PageBreak[] {
  return currentPageBreaks(ed.state).map((b) => ({ target: b.target, shift: Math.round(b.shift) }));
}

describe('the page view in a 100,000-word note', () => {
  it('keeps the pauses in typing short, and the pages follow the text', async () => {
    const t = pagedLongNote(5000);
    await expect.poll(() => currentPageBreaks(t.ed.state).length, { timeout: 30_000 }).toBeGreaterThan(200);
    await t.wait(2000);

    // Three seconds of typing near the top at ten keys a second, each key a
    // word, so lines wrap and every page below moves now and then.
    t.timings.length = 0;
    const before = breaks(t.ed);
    t.ed.commands.setTextSelection(3);
    for (let i = 0; i < 30; i++) {
      t.ed.view.dispatch(t.ed.state.tr.insertText('wordy '));
      await t.wait(100);
    }
    await t.wait(2000);
    const slowest = Math.max(...t.timings);
    const busy = t.timings.reduce((a, b) => a + b, 0);
    // About 24 ms on the owner's Windows PC, where Filo runs, run alone, and
    // 31 ms with the rest of the suite running beside it; GitHub's Linux
    // runner is slower. Before, 81 to 92 ms alone. The total is the guard
    // that bites anywhere (1,800 ms before).
    const budget = navigator.userAgent.includes('Windows') ? 45 : 90;
    expect(slowest, `the slowest pause was ${Math.round(slowest)} ms`).toBeLessThan(budget);
    expect(busy, `measuring took ${Math.round(busy)} ms of the typing`).toBeLessThan(300);

    // The pages moved with the text, to where a measure of the whole note puts them.
    const afterTyping = breaks(t.ed);
    expect(afterTyping).not.toEqual(before);
    t.view.refresh();
    await t.wait(2500);
    expect(breaks(t.ed)).toEqual(afterTyping);
  }, 120_000);

  it('waits for a longer pause the longer the note', () => {
    expect(measureWaits(100)).toEqual({ debounce: 60, maxWait: 250 });
    expect(measureWaits(1000).debounce).toBeGreaterThan(60);
    expect(measureWaits(5000).debounce).toBeGreaterThan(measureWaits(1000).debounce);
    expect(measureWaits(5000).maxWait).toBeGreaterThan(measureWaits(5000).debounce);
  });
});

describe('the page view after an edit', () => {
  it('puts the breaks where a measure of the whole note does, after a paragraph is split, joined and grown', async () => {
    const t = pagedLongNote(300);
    await expect.poll(() => currentPageBreaks(t.ed.state).length, { timeout: 10_000 }).toBeGreaterThan(10);
    await t.wait(600);
    const settle = async (): Promise<PageBreak[]> => {
      await t.wait(600);
      const incremental = breaks(t.ed);
      t.view.refresh();
      await t.wait(600);
      return incremental;
    };

    // Enter in the middle of the 40th paragraph: one block becomes two.
    const pos40 = (() => {
      let at = 0;
      t.ed.state.doc.forEach((_n, offset, index) => { if (index === 40) at = offset; });
      return at;
    })();
    t.ed.commands.setTextSelection(pos40 + 30);
    t.ed.commands.splitBlock();
    expect(await settle()).toEqual(breaks(t.ed));

    // Backspace at its start joins them again.
    t.ed.commands.setTextSelection(pos40 + 32);
    t.ed.commands.joinBackward();
    expect(await settle()).toEqual(breaks(t.ed));

    // Five lines added to a paragraph far down the note.
    t.ed.commands.setTextSelection(t.ed.state.doc.content.size - 40);
    t.ed.commands.insertContent(' more'.repeat(80));
    expect(await settle()).toEqual(breaks(t.ed));

    // An image-like growth with no edit: a block made taller from outside.
    const el = t.ed.view.dom.children[5] as HTMLElement;
    el.style.paddingBottom = '600px';
    expect(await settle()).toEqual(breaks(t.ed));
  }, 60_000);
});
