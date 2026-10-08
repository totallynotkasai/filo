import { describe, it, expect, afterEach } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { Editor } from '@tiptap/core';
import { compile } from 'svelte/compiler';
import '../../css/style.css';
import documentEditorSource from '../../renderer/components/boards/DocumentEditor.svelte?raw';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { renderNotePreviewHtml } from '../../renderer/lib/editor/staticPreview';
import { tiptapToolbar } from '../../renderer/lib/editor/toolbarConfig';
import { LINE_SPACING_CHOICES } from '../../renderer/stores/noteMeta';

/**
 * Paragraph spacing as it is drawn, in a tile, a card's preview and a
 * Document tab (decision D1: tight). Enter puts the next paragraph on the
 * next line with no gap, and a list stands the same: its items are a line
 * apart, like paragraphs, at every Line Spacing. Only a whole list keeps a
 * margin below it.
 *
 * The Document tab's rules are compiled from `DocumentEditor.svelte` itself,
 * so the spec follows any change to them.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) {
    const ed = editors.pop()!;
    tiptapToolbar.releaseEditor(ed);
    ed.destroy();
  }
  document.body.innerHTML = '';
  document.head.querySelectorAll('style[data-spec]').forEach((s) => s.remove());
});

/** Paragraphs, then a list of each kind, every block one short line. */
const NOTE = [
  'First paragraph',
  'Second paragraph',
  '- bullet one\n- bullet two',
  'Between',
  '1. number one\n2. number two',
  'Between again',
  '- [ ] task one\n- [x] task two',
  'Last paragraph',
].join('\n\n');

/** A tile's or card's editor box at `lineSpacing`, as TextTile sets it. */
function tileBox(lineSpacing: number): HTMLElement {
  const tile = document.createElement('div');
  tile.className = 'text-tile';
  const box = document.createElement('div');
  box.className = 'editor-container';
  box.style.cssText = `width: 360px; font-size: 13px; line-height: ${lineSpacing};`;
  tile.appendChild(box);
  document.body.appendChild(tile);
  return box;
}

function tileEditor(markdown: string, lineSpacing: number): Editor {
  const ed = createTiptapEditor({ element: tileBox(lineSpacing), content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, markdown);
  return ed;
}

/** A card's static preview, as LazyTextTileBody draws it before its editor mounts. */
function cardPreview(markdown: string, lineSpacing: number): HTMLElement {
  const preview = document.createElement('div');
  preview.className = 'tiptap lazy-preview-text';
  preview.style.whiteSpace = 'pre-wrap';
  preview.innerHTML = renderNotePreviewHtml(markdown);
  tileBox(lineSpacing).appendChild(preview);
  return preview;
}

let documentRules: { css: string; scope: string } | null = null;

/** The Document tab's own styles and the class that scopes them. */
function documentStyles(): { css: string; scope: string } {
  if (!documentRules) {
    const css = compile(documentEditorSource, { filename: 'DocumentEditor.svelte', css: 'external', generate: 'client' }).css?.code ?? '';
    const scope = /\.document-editor\.(svelte-[a-z0-9]+)/.exec(css)?.[1];
    if (!scope) throw new Error("DocumentEditor.svelte's styles don't scope `.document-editor`");
    documentRules = { css, scope };
  }
  return documentRules;
}

function documentEditor(markdown: string, lineSpacing: number): Editor {
  const { css, scope } = documentStyles();
  const style = document.createElement('style');
  style.dataset.spec = '';
  style.textContent = css;
  document.head.appendChild(style);
  const host = document.createElement('div');
  host.className = `document-editor ${scope}`;
  host.style.width = '640px';
  host.style.setProperty('--note-line-height', String(lineSpacing));
  document.body.appendChild(host);
  const ed = createTiptapEditor({ element: host, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, markdown);
  return ed;
}

/** The space between the bottom of one line of text and the top of the next. */
function gap(a: Element, b: Element): number {
  return Math.round(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom);
}

interface Gaps {
  paragraphs: number;
  bullets: number;
  numbers: number;
  tasks: number;
  belowList: number;
}

/** The gaps in a rendered NOTE (an editor's root, or a preview). */
function gapsIn(root: HTMLElement): Gaps {
  const paragraphs = root.querySelectorAll(':scope > p');
  const lists = root.querySelectorAll(':scope > ul, :scope > ol');
  // An item's line: its paragraph in the editor, the item itself in a tight preview list.
  const lines = (list: Element): Element[] =>
    [...list.querySelectorAll(':scope > li')].map((li) => li.querySelector('p') ?? li);
  const [b1, b2] = lines(lists[0]!);
  const [n1, n2] = lines(lists[1]!);
  const [t1, t2] = lines(lists[2]!);
  return {
    paragraphs: gap(paragraphs[0]!, paragraphs[1]!),
    bullets: gap(b1!, b2!),
    numbers: gap(n1!, n2!),
    tasks: gap(t1!, t2!),
    belowList: gap(lists[0]!, paragraphs[2]!),
  };
}

describe('lists stand as close as the paragraphs around them', () => {
  for (const lineSpacing of LINE_SPACING_CHOICES) {
    it(`in a tile, at line spacing ${lineSpacing}`, () => {
      const g = gapsIn(tileEditor(NOTE, lineSpacing).view.dom);
      expect({ ...g, belowList: g.belowList > 0 }).toEqual({ paragraphs: 0, bullets: 0, numbers: 0, tasks: 0, belowList: true });
    });

    it(`in a card's preview, at line spacing ${lineSpacing}`, () => {
      const g = gapsIn(cardPreview(NOTE, lineSpacing));
      expect({ ...g, belowList: g.belowList > 0 }).toEqual({ paragraphs: 0, bullets: 0, numbers: 0, tasks: 0, belowList: true });
    });

    it(`in a Document tab, at line spacing ${lineSpacing}`, () => {
      const g = gapsIn(documentEditor(NOTE, lineSpacing).view.dom);
      expect({ ...g, belowList: g.belowList > 0 }).toEqual({ paragraphs: 0, bullets: 0, numbers: 0, tasks: 0, belowList: true });
    });
  }

  it('a sub-list sits a line under its item, and the next item a line under it', () => {
    const ed = tileEditor('- one\n  - nested\n- two', 1.5);
    const [one, nested, two] = [...ed.view.dom.querySelectorAll('li > p')];
    expect([gap(one!, nested!), gap(nested!, two!)]).toEqual([0, 0]);
  });

  it("a card's preview stands as tall as its editor", () => {
    const body = 'Para one\n\n\nPara two\n\n- a\n- b\n\nMiddle\n\n- [ ] c\n- [x] d\n\n\n\nEnd';
    const editorHeight = tileEditor(body, 1.5).view.dom.getBoundingClientRect().height;
    const previewHeight = cardPreview(body, 1.5).getBoundingClientRect().height;
    expect(Math.round(previewHeight)).toBe(Math.round(editorHeight));
  });
});

describe('Heading 3 on one line of a soft-broken block (a note with a 19-line stat block)', () => {
  const STATS = [
    '**Potential stats**',
    'Physical (likely capped)',
    'Strength - raw power, lifting/striking',
    'Endurance - stamina, how long you can fight/cast',
    'Vitality - HP pool, regeneration, disease resistance',
    'Mental / magical (likely uncapped or soft-capped)',
    'Mana / Mind - capacity',
    'Edge stats worth considering',
    'Luck - rare and meaningful when it appears',
  ].join('\n');

  it('changes that line alone, and Ctrl+Z puts it back', async () => {
    const ed = documentEditor(`Intro paragraph.\n\n${STATS}\n\nAfter.`, 1.5);
    ed.view.focus();
    let pos = -1;
    ed.state.doc.descendants((n, p) => {
      if (pos < 0 && n.isText && n.text!.startsWith('Physical')) pos = p + 2;
      return pos < 0;
    });
    ed.commands.setTextSelection(pos);
    tiptapToolbar.setActiveEditor(ed);
    expect(tiptapToolbar.setHeading(3)).toBe(true);

    expect(editorMarkdown(ed)).toBe(
      'Intro paragraph.\n\n**Potential stats**\n\n### Physical (likely capped)\n\n' +
        STATS.split('\n').slice(2).join('\n') + '\n\nAfter.',
    );
    // Drawn: one heading, and the lines after it still the body's size.
    const headings = [...ed.view.dom.querySelectorAll('h3')];
    expect(headings.map((h) => h.textContent)).toEqual(['Physical (likely capped)']);
    const strength = [...ed.view.dom.querySelectorAll('p')].find((p) => p.textContent!.startsWith('Strength'))!;
    expect(getComputedStyle(strength).fontSize).toBe('16px');

    await userEvent.keyboard('{Control>}z{/Control}');
    await expect.poll(() => editorMarkdown(ed)).toBe(`Intro paragraph.\n\n${STATS}\n\nAfter.`);
  });
});
