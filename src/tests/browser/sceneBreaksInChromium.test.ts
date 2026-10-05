import { describe, it, expect, afterEach } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * Lines typed as text stay text on Enter, and a scene break typed on a line
 * of its own becomes a horizontal rule, with real keys in Chromium.
 *
 * TipTap ran its input rules on Enter too: a lone `#` (the manuscript scene
 * break) and Enter made an empty heading that took the next line, `* * *`
 * became a bullet list, and "1984. It was…" a list numbered from 1984.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

function makeEditor(): Editor {
  const el = document.createElement('div');
  el.style.width = '480px';
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  return ed;
}

/** A note holding "Start.", the caret at its end, then `keys` typed. */
async function typeAfterStart(keys: string): Promise<Editor> {
  const ed = makeEditor();
  loadMarkdownIntoEditor(ed, 'Start.');
  ed.view.focus();
  ed.commands.setTextSelection(ed.state.doc.content.size - 1);
  await userEvent.keyboard(keys);
  await new Promise((r) => setTimeout(r, 50));
  return ed;
}

/** The note's blocks, by type and text. */
function blocks(ed: Editor): string[] {
  const out: string[] = [];
  ed.state.doc.forEach((node) => out.push(node.textContent ? `${node.type.name}: ${node.textContent}` : node.type.name));
  return out;
}

/** Saves, reopens, and saves again: the note reads back as written. */
function expectReadsBack(ed: Editor): string {
  const md = editorMarkdown(ed);
  const again = makeEditor();
  const { lossy } = loadMarkdownIntoEditor(again, md);
  expect(lossy).toBe(false);
  expect(editorMarkdown(again)).toBe(md);
  return md;
}

describe('a scene break typed on a line of its own becomes a horizontal rule on Enter', () => {
  const BREAKS: { name: string; keys: string }[] = [
    { name: 'a lone #', keys: '{Enter}#{Enter}Next scene.' },
    { name: '* * *', keys: '{Enter}* * *{Enter}Next scene.' },
    { name: '- - -', keys: '{Enter}- - -{Enter}Next scene.' },
    { name: '_ _ _', keys: '{Enter}_ _ _{Enter}Next scene.' },
    { name: '***', keys: '{Enter}***{Enter}Next scene.' },
  ];
  for (const c of BREAKS) {
    it(`${c.name}, and the next line is plain text`, async () => {
      const ed = await typeAfterStart(c.keys);
      expect(blocks(ed)).toEqual(['paragraph: Start.', 'horizontalRule', 'paragraph: Next scene.']);
      expect(expectReadsBack(ed)).toBe('Start.\n\n---\n\nNext scene.');
    });
  }

  it('Ctrl+Z puts the typed line back', async () => {
    const ed = await typeAfterStart('{Enter}#{Enter}');
    expect(blocks(ed)).toEqual(['paragraph: Start.', 'horizontalRule', 'paragraph']);
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(blocks(ed)).toEqual(['paragraph: Start.', 'paragraph: #']);
  });
});

describe('a line typed as text stays text on Enter', () => {
  const TEXT_LINES: { name: string; keys: string; expected: string[] }[] = [
    { name: '## alone', keys: '{Enter}##{Enter}Next', expected: ['paragraph: Start.', 'paragraph: ##', 'paragraph: Next'] },
    { name: '> alone', keys: '{Enter}>{Enter}Next', expected: ['paragraph: Start.', 'paragraph: >', 'paragraph: Next'] },
    { name: '- alone', keys: '{Enter}-{Enter}Next', expected: ['paragraph: Start.', 'paragraph: -', 'paragraph: Next'] },
    { name: '1. alone', keys: '{Enter}1.{Enter}Next', expected: ['paragraph: Start.', 'paragraph: 1.', 'paragraph: Next'] },
    {
      name: 'a year opening a sentence',
      keys: '{Enter}1984. It was a bright cold day.',
      expected: ['paragraph: Start.', 'paragraph: 1984. It was a bright cold day.'],
    },
  ];
  for (const c of TEXT_LINES) {
    it(c.name, async () => {
      const ed = await typeAfterStart(c.keys);
      expect(blocks(ed)).toEqual(c.expected);
      expectReadsBack(ed);
    });
  }
});

describe('markers typed with a space still start their block', () => {
  const MARKERS: { name: string; keys: string; type: string }[] = [
    { name: '# and a space: a heading', keys: '{Enter}# Title', type: 'heading' },
    { name: '- and a space: a bullet list', keys: '{Enter}- item', type: 'bulletList' },
    { name: '* and a space: a bullet list', keys: '{Enter}* item', type: 'bulletList' },
    { name: '1. and a space: a numbered list', keys: '{Enter}1. item', type: 'orderedList' },
    { name: '12. and a space: a numbered list from 12', keys: '{Enter}12. item', type: 'orderedList' },
    { name: '> and a space: a quote', keys: '{Enter}> quoted', type: 'blockquote' },
  ];
  for (const c of MARKERS) {
    it(c.name, async () => {
      const ed = await typeAfterStart(c.keys);
      expect(ed.state.doc.child(1).type.name).toBe(c.type);
      expectReadsBack(ed);
    });
  }

  it('[ ] and a space: a checklist', async () => {
    const ed = await typeAfterStart('{Enter}[[ ] task');
    expect(ed.state.doc.child(1).type.name).toBe('taskList');
  });

  it('* * * in a list with other items stays text', async () => {
    const ed = await typeAfterStart('{Enter}- one{Enter}* * *{Enter}');
    expect(ed.state.doc.child(1).type.name).toBe('bulletList');
    expect(ed.state.doc.child(1).textContent).toContain('* * *');
  });
});
