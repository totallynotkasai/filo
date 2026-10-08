import { describe, it, expect, afterEach } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { Editor } from '@tiptap/core';
import '../../css/style.css';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { attachPageView, currentPageBreaks, type PageView } from '../../renderer/lib/editor/pageBreaks';
import type { PageRect } from '../../renderer/lib/editor/pageLayout';

/**
 * The Document tab's page view in a real layout engine: jsdom lays nothing
 * out, so only here do blocks have places for the pages to break between.
 *
 * The column is built as the Document tab builds it (an 812 px paper with
 * 56 px top and bottom bands, so pages 1148 px tall), with the tab's rules
 * for the break space. Each case waits for the layout to settle, then checks
 * what a reader sees: every block's text inside a page's text area, at any
 * zoom and after edits, and nothing of it in the note or its undo history.
 */

const BREAK_RULES = `
  .page-column { width: 812px; padding: 56px 72px; box-sizing: border-box; position: relative; }
  .page-column .tiptap { font-size: 16px; line-height: 1.5; }
  .page-column .tiptap p { margin-top: 0; margin-bottom: 1.25em; }
  .page-column .tiptap p:has(+ p) { margin-bottom: 0; }
  .page-column .tiptap pre { padding: 16px; background: #eee; }
  .page-column .tiptap .filo-page-break { padding-top: var(--filo-page-break, 0px); }
  .page-column .tiptap pre.filo-page-break {
    padding-top: calc(16px + var(--filo-page-break, 0px));
    background: linear-gradient(to bottom, transparent var(--filo-page-break, 0px), #eee var(--filo-page-break, 0px));
  }
`;

const PAD = 56;

interface Paged {
  ed: Editor;
  column: HTMLElement;
  wrapper: HTMLElement;
  pages: () => PageRect[];
  view: PageView;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.body.innerHTML = '';
  document.head.querySelectorAll('style[data-page-test]').forEach((s) => s.remove());
});

let lastPagesAt = 0;

function pagedEditor(markdown: string): Paged {
  const style = document.createElement('style');
  style.dataset.pageTest = '';
  style.textContent = BREAK_RULES;
  document.head.appendChild(style);
  const wrapper = document.createElement('div');
  const column = document.createElement('div');
  column.className = 'page-column';
  const host = document.createElement('div');
  column.appendChild(host);
  wrapper.appendChild(column);
  document.body.appendChild(wrapper);

  const ed = createTiptapEditor({ element: host, content: '' });
  loadMarkdownIntoEditor(ed, markdown);
  let pages: PageRect[] = [];
  const view = attachPageView(ed, {
    column: () => column,
    observed: () => [],
    onPages: (next) => {
      pages = next;
      lastPagesAt = performance.now();
    },
  });
  view.setEnabled(true);
  cleanups.push(() => {
    view.destroy();
    ed.destroy();
  });
  return { ed, column, wrapper, pages: () => pages, view };
}

/** Waits until the pages have stopped changing for a while. */
async function settled(p: Paged, minPages = 2): Promise<void> {
  await expect.poll(() => p.pages().length >= minPages && performance.now() - lastPagesAt > 500, { timeout: 5000 }).toBe(true);
}

/** Every leaf block of the note, as the reader sees it, px from the first page's top. */
function blockBoxes(p: Paged): Array<{ el: HTMLElement; top: number; bottom: number }> {
  const columnRect = p.column.getBoundingClientRect();
  const scale = columnRect.width / p.column.offsetWidth;
  const leaves = p.ed.view.dom.querySelectorAll<HTMLElement>(':scope > p, :scope > h1, :scope > h2, :scope > pre, :scope > .tableWrapper, li > p');
  return [...leaves].map((el) => {
    const rect = el.getBoundingClientRect();
    // A block that starts a page carries the space above its text as padding.
    const space = el.classList.contains('filo-page-break') ? parseFloat(getComputedStyle(el).getPropertyValue('--filo-page-break')) || 0 : 0;
    return {
      el,
      top: (rect.top - columnRect.top) / scale + space,
      bottom: (rect.bottom - columnRect.top) / scale,
    };
  });
}

function expectBlocksInsidePages(p: Paged): void {
  const pages = p.pages();
  for (const box of blockBoxes(p)) {
    const page = pages.find((pg) => box.top >= pg.top - 1 && box.top < pg.top + pg.height);
    expect(page, `a page for the block at ${box.top}`).toBeDefined();
    expect(box.top).toBeGreaterThanOrEqual(page!.top + PAD - 1);
    expect(box.bottom).toBeLessThanOrEqual(page!.top + page!.height - PAD + 1);
  }
}

const SENTENCES = [
  'Aria rode north along the river road until the light failed.',
  'The ferryman asked for two coins and took three.',
  'Nobody in Vel remembered the winter the bridge came down, but everyone told the story as if they had stood on the bank and watched the ice take it, plank by plank, while the bells rang out across the water.',
  'She kept the letter folded inside her glove.',
];

function longNote(): string {
  const parts: string[] = ['# The River Road'];
  for (let i = 0; i < 40; i++) {
    parts.push(Array.from({ length: 1 + (i % 4) }, (_, j) => SENTENCES[(i + j) % SENTENCES.length]).join(' '));
    if (i === 12) parts.push(Array.from({ length: 30 }, (_, j) => `- Item ${j + 1}: ${SENTENCES[j % 4]}`).join('\n'));
    if (i === 20) parts.push('```\nconst ferry = { coins: 3 };\nconsole.log(ferry);\n```');
    if (i === 25) parts.push('| Place | Days |\n| --- | --- |\n| Vel | 3 |\n| Kasai | 5 |');
    if (i === 30) parts.push('---');
  }
  return parts.join('\n\n') + '\n';
}

describe('page breaks', () => {
  it('lays a long note out on pages, every block inside a page’s text area', async () => {
    const p = pagedEditor(longNote());
    await settled(p, 3);
    expect(p.pages().every((pg) => pg.height >= 1148)).toBe(true);
    expect(currentPageBreaks(p.ed.state).length).toBe(p.pages().length - 1);
    expectBlocksInsidePages(p);
  });

  it('leaves the note, its saved Markdown and its undo history alone', async () => {
    const markdown = longNote();
    const p = pagedEditor(markdown);
    const before = { json: p.ed.getJSON(), saved: editorMarkdown(p.ed) };
    await settled(p, 3);
    expect(p.ed.getJSON()).toEqual(before.json);
    expect(editorMarkdown(p.ed)).toBe(before.saved);
    expect(p.ed.getHTML()).not.toContain('filo-page-break');
    expect(p.ed.can().undo()).toBe(false);
  });

  it('lays the pages out again after an edit pushes text down', async () => {
    const p = pagedEditor(longNote());
    await settled(p, 3);
    const breaksBefore = currentPageBreaks(p.ed.state).map((b) => b.target);
    // A paragraph's worth of text near the top moves every later break.
    p.ed.commands.setTextSelection(20);
    p.ed.commands.insertContent(`${SENTENCES[2]} ${SENTENCES[2]} ${SENTENCES[2]}`);
    lastPagesAt = performance.now();
    await expect.poll(() => currentPageBreaks(p.ed.state).map((b) => b.target)).not.toEqual(breaksBefore.map((t) => t));
    await settled(p, 3);
    expectBlocksInsidePages(p);
  });

  it('keeps every block inside its page when zoomed', async () => {
    const p = pagedEditor(longNote());
    await settled(p, 3);
    p.wrapper.style.zoom = '1.5';
    p.view.refresh();
    lastPagesAt = performance.now();
    await settled(p, 3);
    expectBlocksInsidePages(p);

    // A click lands where it is pointed, on a page past the first.
    const boxes = blockBoxes(p).filter((b) => b.el.tagName === 'P' && b.top > 1148);
    const target = boxes[0]!.el;
    const rect = target.getBoundingClientRect();
    const hit = p.ed.view.posAtCoords({ left: rect.left + 20, top: rect.bottom - 4 });
    const from = p.ed.view.posAtDOM(target, 0);
    expect(hit).not.toBeNull();
    expect(hit!.pos).toBeGreaterThanOrEqual(from);
    expect(hit!.pos).toBeLessThanOrEqual(from + (target.textContent ?? '').length);
  });

  it('moves the caret across the gap between two pages with the arrow keys', async () => {
    const p = pagedEditor(longNote());
    await settled(p, 3);
    // The first break on a paragraph, and the paragraph above it.
    const breakAt = currentPageBreaks(p.ed.state).find((b) => p.ed.state.doc.nodeAt(b.target)?.type.name === 'paragraph');
    expect(breakAt).toBeDefined();
    const $break = p.ed.state.doc.resolve(breakAt!.target);
    const above = $break.nodeBefore;
    expect(above?.type.name).toBe('paragraph');
    p.ed.view.focus();
    p.ed.commands.setTextSelection(breakAt!.target - 1);
    await expect.poll(() => p.ed.state.selection.from).toBe(breakAt!.target - 1);
    await userEvent.keyboard('{ArrowDown}');
    const nextNode = p.ed.state.doc.nodeAt(breakAt!.target)!;
    await expect.poll(() => {
      const at = p.ed.state.selection.from;
      return at > breakAt!.target && at < breakAt!.target + nextNode.nodeSize;
    }).toBe(true);
  });

  it('turned off, takes every break away', async () => {
    const p = pagedEditor(longNote());
    await settled(p, 3);
    p.view.setEnabled(false);
    expect(p.pages()).toEqual([]);
    expect(currentPageBreaks(p.ed.state)).toEqual([]);
    expect(p.ed.view.dom.querySelector('.filo-page-break')).toBeNull();
  });
});
