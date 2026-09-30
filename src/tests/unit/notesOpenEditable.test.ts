import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor, type RoundTripChange } from '../../renderer/lib/editor/markdownSync';
import { normaliseLinkUrl } from '../../renderer/lib/editor/linkUrl';
import { assembleNoteText, readNoteText, sameBody } from '../../renderer/lib/notes/noteFile';

/**
 * Notes written in Keep or Obsidian open editable when all a save would
 * change is how they are spelled, and read-only (naming a line) only when a
 * save would change what they say.
 *
 * Each case loads the file into the real editor, as a Document tab does.
 */

const editors: Editor[] = [];
function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  return ed;
}
afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

function open(body: string): { ed: Editor; lossy: boolean; changes: RoundTripChange[]; saved: string } {
  const ed = makeEditor();
  const { lossy, changes } = loadMarkdownIntoEditor(ed, body);
  return { ed, lossy, changes, saved: editorMarkdown(ed) };
}

/** Types `text` at the end of the note's last text, as a keypress would. */
function typeAtEnd(ed: Editor, text: string): void {
  let end = 0;
  ed.state.doc.descendants((node, pos) => {
    if (node.isText) end = pos + node.nodeSize;
  });
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, end)).insertText(text));
}

describe('shapes that only change spelling open editable', () => {
  it.each([
    ['a checklist straight under text', 'Todo:\n- [ ] one\n- [x] two\n'],
    ['a list straight under text', 'Ideas for chapter 4:\n- the lantern market\n- a debt owed\n'],
    ['a numbered list straight under text', 'Steps:\n1. one\n2. two\n'],
    ['text straight under a heading', '# Title\nText right under\n'],
    ['a heading straight under text', 'Text\n# Heading\n'],
    ['a list straight under a heading', '# H\n- a\n- b\n'],
    ['a quote straight under text', 'He said:\n> hello\n'],
    ['a code fence straight under text', 'Text\n```\ncode\n```\n'],
    ['a table straight under text', 'Intro\n| a | b |\n|---|---|\n| 1 | 2 |\n'],
    ['an unspaced *** scene break', 'Scene one.\n***\nScene two.\n'],
    ['a list numbered 1. 1. 1.', '1. one\n1. two\n1. three\n'],
    ['a list numbered 01. 02.', '01. Arrival\n02. Departure\n'],
    ['a list item\'s lazy continuation', '- milk\n- eggs\nThen go home\n'],
    ['a quote\'s lazy continuation', '> quoted\nnot quoted?\n'],
    ['an entity', 'a &copy; b\n'],
    ['a raw < and >', 'a < b and c > d\n'],
    ['a tab opening a heading', '#\tTitle\n'],
    ['an indented continuation line', 'a\n  b\n'],
    ['inline code padded with spaces', 'x ` a ` y\n'],
    ['a " in a link address', '[x](https://x.com/a"b)\n'],
  ])('%s', (_name, body) => {
    const r = open(body);
    expect(r.lossy).toBe(false);
    // What it saves reads back as a note Filo writes the same way.
    const again = open(r.saved);
    expect(again.lossy).toBe(false);
    expect(again.saved).toBe(r.saved);
  });
});

describe('shapes that save byte for byte', () => {
  it.each([
    ['a bare URL ending the first paragraph', 'Source: https://example.com\n\nNext para'],
    ['a bare URL ending a heading', '# Links https://example.com\n\nbody'],
    ['two bare URLs in the first paragraph', 'See https://a.com and https://b.com\n\nx'],
    ['wiki links and embeds', 'See [[Page]] and ![[img.png]]'],
    ['a wiki link in a heading, brackets in text', '# [[Page]]\n\ntext [x] y'],
    ['a callout', '> [!note] Title\n> body'],
    ['a [TODO] marker', 'Top\n\n[TODO] x\n\nEnd'],
    ['an image path with a space', '![alt](Attachments/My Pic.png)'],
    ['a #tag starting a line', '#tag at start'],
    ['a number that can\'t start a list under text', 'Line one\n2. then 3 coins'],
    ['a tab before a soft break', 'Line\t\nnext'],
    ['a tab before a hard break', 'Line\t\\\nnext'],
    ['a Windows path', 'Open C:\\Users\\me\\file.txt now'],
    ['a footnote', 'A claim.[^1]\n\n[^1]: the source'],
    ['a file\'s own escapes', 'x \\[y\\] z and \\[a] b'],
  ])('%s', (_name, body) => {
    const r = open(body);
    expect(r.lossy).toBe(false);
    expect(r.saved).toBe(body);
  });

  it('a bare URL stays text on load (not linked), and still links while typing', () => {
    const r = open('Source: https://example.com\n\nNext para');
    let linked = false;
    r.ed.state.doc.descendants((node) => {
      if (node.marks.some((m) => m.type.name === 'link')) linked = true;
    });
    expect(linked).toBe(false);
    typeAtEnd(r.ed, ' see https://filo.test ');
    expect(editorMarkdown(r.ed)).toContain('<https://filo.test>');
  });

  it('an edit elsewhere leaves wiki links, callouts and brackets as the file has them', () => {
    const body = '> [!note] Title\n> body\n\nSee [[Page]] and [TODO] x\n\nLast line';
    const r = open(body);
    typeAtEnd(r.ed, ' more');
    expect(editorMarkdown(r.ed)).toBe(`${body} more`);
  });

  it('a bullet whose text starts with [ ] keeps an escape, so it stays a bullet (not a task)', () => {
    const r = open('- \\[ \\] not a task');
    expect(r.lossy).toBe(false);
    typeAtEnd(r.ed, '!');
    const saved = editorMarkdown(r.ed);
    expect(saved).toMatch(/^- (\\\[ \\\]|\\\[ \]|\[ \\\]) not a task!$/);
    const again = open(saved);
    expect(again.ed.state.doc.firstChild?.type.name).toBe('bulletList');
  });

  it('brackets typed in Filo are written bare where they read the same, on an edited line too', () => {
    const r = open('Hello');
    typeAtEnd(r.ed, ' [x] and [[Page]]');
    expect(editorMarkdown(r.ed)).toBe('Hello [x] and [[Page]]');
    const obsidian = open('See [[Page]] and [TODO] x');
    typeAtEnd(obsidian.ed, ' done');
    expect(editorMarkdown(obsidian.ed)).toBe('See [[Page]] and [TODO] x done');
  });
});

describe('shapes that change what the note says stay read-only, naming a line', () => {
  it('an HTML comment', () => {
    const r = open('a\n<!-- c -->\nb\n');
    expect(r.lossy).toBe(true);
    expect(r.changes).toEqual([{ original: '<!-- c -->', filo: '' }]);
  });

  it('a reference definition, used or not (it renders nothing, but a save would drop it)', () => {
    const used = open('See [a][1].\n\n[1]: http://x.com\n');
    expect(used.lossy).toBe(true);
    expect(used.changes[0]).toEqual({ original: 'See [a][1].', filo: 'See [a](http://x.com).' });
    const unused = open('Hello\n\n[1]: http://x.com\n');
    expect(unused.lossy).toBe(true);
    expect(unused.changes).toEqual([{ original: '[1]: http://x.com', filo: '' }]);
  });

  it('the blank line Filo adds is not what the banner names when something else changes', () => {
    const r = open('Text\n# Heading\n<!-- c -->\n');
    expect(r.lossy).toBe(true);
    expect(r.changes).toEqual([{ original: '<!-- c -->', filo: '' }]);
  });
});

describe('minimal escapes are a fixed point', () => {
  it('two identical lines whose `*` would pair: the file\'s spelling of each is kept', () => {
    // What an earlier save wrote: one escape dropped, the other kept.
    const body = 'a * b\na \\* b';
    const r = open(body);
    expect(r.lossy).toBe(false);
    expect(r.saved).toBe(body);
    const swapped = open('a \\* b\na * b');
    expect(swapped.saved).toBe('a \\* b\na * b');
  });

  it('a line whose escapes were dropped only in part is written back as it is', () => {
    // `\*a* b`: the search would drop the first escape instead (`*a\* b`).
    for (const body of ['\\*a* b', '*a\\* b', 'x \\*\\* y \\_z w']) {
      const r = open(body);
      expect(r.saved).toBe(body);
    }
  });
});

describe('links typed into the Insert Link popup', () => {
  it('a " (and the other characters markdown-it encodes) is saved encoded, so it reads back as typed', () => {
    const href = normaliseLinkUrl('https://x.com/a"b<c>`d{e}|f\\g^h');
    expect(href).toBe('https://x.com/a%22b%3Cc%3E%60d%7Be%7D%7Cf%5Cg%5Eh');
    const r = open('Go');
    r.ed.chain().selectAll().setLink({ href: href ?? '' }).run();
    const saved = editorMarkdown(r.ed);
    const again = open(saved);
    expect(again.lossy).toBe(false);
    expect(again.saved).toBe(saved);
  });
});

describe('the blank line after the frontmatter', () => {
  it('survives a body edit', () => {
    const fresh = readNoteText('---\ntitle: A\n---\n\n# Heading\n\nText\n');
    expect(assembleNoteText(fresh, { body: '# Heading\n\nText more' })).toBe('---\ntitle: A\n---\n\n# Heading\n\nText more\n');
  });

  it('survives a body edit with a frontmatter change, in CRLF, and two blank lines stay two', () => {
    const fresh = readNoteText('---\r\ntitle: A\r\n---\r\n\r\n\r\nText\r\n');
    const out = assembleNoteText(fresh, { body: 'Text more', delta: { set: { status: 'done' }, unset: [] } });
    expect(out).toBe('---\r\ntitle: A\r\nstatus: done\r\n---\r\n\r\n\r\nText more\r\n');
  });

  it('a note with none gains none, and a note Filo created blank keeps its blank line', () => {
    expect(assembleNoteText(readNoteText('---\ntitle: A\n---\nText\n'), { body: 'Text more' })).toBe(
      '---\ntitle: A\n---\nText more\n',
    );
    expect(assembleNoteText(readNoteText('---\ntitle: A\n---\n\n'), { body: 'Typed' })).toBe('---\ntitle: A\n---\n\nTyped\n');
  });

  it('a note without frontmatter is left as the editor writes it', () => {
    expect(assembleNoteText(readNoteText('\nText\n'), { body: 'Text more' })).toBe('Text more\n');
  });

  it('a body compared with its editor text ignores the blank lines above it', () => {
    expect(sameBody('\n# Heading\n', '# Heading')).toBe(true);
    expect(sameBody('\n# Heading\n', '# Other')).toBe(false);
  });
});
