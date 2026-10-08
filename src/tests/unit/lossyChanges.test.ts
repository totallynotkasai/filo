import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '@renderer/lib/editor/createEditor';
import { loadMarkdownIntoEditor, parseMarkdownFile, roundTripChanges, lineOfRoundTripChange } from '@renderer/lib/editor/markdownSync';
import { describeChange, locateChanges } from '@renderer/lib/editor/lossyChanges';
import { firstRenderedChange } from '@renderer/lib/editor/lossyCause';
import MarkdownIt from 'markdown-it';

describe('roundTripChanges', () => {
  it('is empty when nothing differs (in the check\'s normal form)', () => {
    expect(roundTripChanges('* a\n* b', '- a\n- b')).toEqual([]);
  });

  it('pairs the lines of the one region that differs', () => {
    expect(roundTripChanges('Top\n\n[TODO] x\n\nEnd', 'Top\n\n\\[TODO\\] x\n\nEnd')).toEqual([
      { original: '[TODO] x', filo: '\\[TODO\\] x' },
    ]);
  });

  it('names a dropped line and an added line', () => {
    expect(roundTripChanges('a\n<!-- note -->\nb', 'a\nb')).toEqual([{ original: '<!-- note -->', filo: '' }]);
    expect(roundTripChanges('a', 'a\n\nextra')).toEqual([{ original: '', filo: 'extra', above: '' }]);
  });

  it('names a blank line saving would add, and the line it goes above', () => {
    // The Keep shape: a list straight under a line of text.
    expect(roundTripChanges('Todo:\n- [ ] one\n- [x] two', 'Todo:\n\n- [ ] one\n- [x] two')).toEqual([
      { original: '', filo: '', above: '- [ ] one' },
    ]);
  });

  it('lists the change that matters before blank lines, and keeps file order', () => {
    const original = 'Text\n# Heading\n<!-- c -->\nEnd';
    const filo = 'Text\n\n# Heading\n\nEnd';
    expect(roundTripChanges(original, filo)).toEqual([{ original: '<!-- c -->', filo: '' }]);
    expect(roundTripChanges('a\nb\nc\nd', 'a\nB\nc\nd\ne')).toEqual([
      { original: 'b', filo: 'B' },
      { original: '', filo: 'e', above: '' },
    ]);
  });

  it('pairs a changed line with its replacement where lines were also added before it', () => {
    expect(roundTripChanges('x\n[1]: http://a\ny', 'x\n\nnew\ny')).toEqual([{ original: '[1]: http://a', filo: 'new' }]);
  });

  it('lists at most three', () => {
    const original = ['1', '2', '3', '4', '5'].map((n) => `[${n}]`).join('\n\n');
    const filo = ['1', '2', '3', '4', '5'].map((n) => `\\[${n}\\]`).join('\n\n');
    expect(roundTripChanges(original, filo)).toHaveLength(3);
  });
});

describe('locating and describing a change', () => {
  const file = '---\ntitle: T\n---\nIntro\n\n* [TODO] x\n';

  it('finds the line in the whole file, after the frontmatter, in normal form', () => {
    expect(lineOfRoundTripChange(file, '- [TODO] x', 4)).toBe(6);
    const [c] = locateChanges(file, [{ original: '- [TODO] x', filo: '- \\[TODO\\] x' }]);
    expect(c.line).toBe(6);
    expect(describeChange(c)).toBe('Line 6 would change from “- [TODO] x” to “- \\[TODO\\] x”');
  });

  it('a line it can\'t find is "a line"; long lines are shortened', () => {
    const [c] = locateChanges(file, [{ original: 'x'.repeat(80), filo: 'y' }]);
    expect(c.line).toBe(0);
    expect(describeChange(c)).toBe(`A line would change from “${'x'.repeat(59)}…” to “y”`);
  });

  it('a dropped line and an added one', () => {
    expect(describeChange({ original: '<!-- c -->', filo: '', line: 3 })).toBe('Line 3 (“<!-- c -->”) would be dropped');
    expect(describeChange({ original: '', filo: 'new', line: 0 })).toBe('Saving would add “new”');
    expect(describeChange({ original: '', filo: '', line: 0 })).toBe('A blank line would be dropped');
  });

  it('an added blank line is placed above the file line it goes before', () => {
    const note = '---\ntitle: T\n---\nTodo:\n- [ ] one\n';
    const [c] = locateChanges(note, [{ original: '', filo: '', above: '- [ ] one' }]);
    expect(c.line).toBe(5);
    expect(describeChange(c)).toBe('Saving would add a blank line above line 5');
    const [d] = locateChanges(note, [{ original: '', filo: 'x', above: 'Todo:' }]);
    expect(describeChange(d)).toBe('Saving would add “x” above line 4');
  });

  it('an added line leaves the line it goes above for the next change', () => {
    const note = 'a\n[TODO] b\n';
    const located = locateChanges(note, [
      { original: '', filo: '', above: '[TODO] b' },
      { original: '[TODO] b', filo: '\\[TODO\\] b' },
    ]);
    expect(located.map((c) => c.line)).toEqual([2, 2]);
  });
});

/**
 * The change that makes a note read-only comes first, said for what it is
 * (Audit-29 H-02). The owner's agent-written note mixes bullets and a
 * checkbox in one list, which Filo saves as a list and a checklist: a change
 * the file shows only as a blank line, so the banner named the first harmless
 * blank line instead, and Take ownership listed the real one third, as "a
 * blank line".
 */
describe('the cause of a read-only note', () => {
  const editors: Editor[] = [];
  afterEach(() => {
    while (editors.length) editors.pop()!.destroy();
  });

  function opened(file: string): { lossy: boolean; located: ReturnType<typeof locateChanges> } {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const ed = createTiptapEditor({ element: el, content: '' });
    editors.push(ed);
    const { lossy, changes } = loadMarkdownIntoEditor(ed, parseMarkdownFile(file).body);
    return { lossy, located: locateChanges(file, changes) };
  }

  const REVIEW = [
    '---',
    'title: Duplicate Review',
    '---',
    '',
    '# Duplicate Review',
    '**Decisions:**',
    '- **Merged:** 1 and 2',
    '- **Kept separate:** 4, 5, 6',
    '',
    '## A. True duplicates',
    '',
    '### 1. Kindled status',
    '- `From Keep`: hybrid status',
    '- `Leveling System Ideas`: Kindled',
    '- **Proposal:** fold them in.',
    '- [ ] Merge  [ ] Keep separate',
    '',
  ].join('\n');

  it('names the list that would be split, at its line, before the blank lines a save adds', () => {
    const { lossy, located } = opened(REVIEW);
    expect(lossy).toBe(true);
    expect(located[0]).toMatchObject({ line: 13, becomes: 'this list would be split into a list and a checklist' });
    expect(describeChange(located[0]!)).toBe('Line 13: this list would be split into a list and a checklist');
    // The blank lines Filo adds between blocks come after it.
    expect(located.slice(1).map(describeChange)).toEqual([
      'Saving would add a blank line above line 6',
      'Saving would add a blank line above line 7',
    ]);
  });

  it('names a dropped block by its line, which says it all', () => {
    const changed = opened('Notes\n\n<!-- kept? -->\n\nEnd\n');
    expect(changed.lossy).toBe(true);
    expect(describeChange(changed.located[0]!)).toBe('Line 3 (“<!-- kept? -->”) would be dropped');
  });

  it('puts the line change inside the first changed block first', () => {
    // The quote's lazy line, written with its `>`, renders the same; the
    // comment dropped from the paragraph is the change.
    const { located } = opened('> quote\nlazy line\n\nText <!-- c --> more\n');
    expect(located.map(describeChange)).toEqual([
      'Line 4 would change from “Text <!-- c --> more” to “Text  more”',
      'Line 2 would change from “lazy line” to “> lazy line”',
    ]);
  });

  it('says where a block change is in a file with no frontmatter, and in one written with CRLF', () => {
    const body = REVIEW.split('\n').slice(4).join('\n');
    expect(opened(body).located[0]).toMatchObject({ line: 9 });
    expect(opened(REVIEW.replace(/\n/g, '\r\n')).located[0]).toMatchObject({ line: 13 });
  });
});

describe('firstRenderedChange', () => {
  const md = new MarkdownIt({ html: true });

  it('says when a block is split, joined or becomes another kind, from its first line', () => {
    expect(firstRenderedChange('Intro\n\n- a\n- b\n', 'Intro\n\n- a\n\n* b\n', md))
      .toEqual({ line: 3, lastLine: 4, becomes: 'this list would be split into a list and a list' });
    expect(firstRenderedChange('- a\n\n* b\n', '- a\n- b\n', md))
      .toMatchObject({ line: 1, becomes: 'these 2 blocks would be joined into a list' });
    expect(firstRenderedChange('Intro\n\n- a\n- b\n', 'Intro\n\n1. a\n2. b\n', md))
      .toMatchObject({ line: 3, becomes: 'this list would become a numbered list' });
    expect(firstRenderedChange('<div>x</div>\n', 'x\n', md)).toMatchObject({ becomes: 'this HTML block would become a paragraph' });
  });

  it('names only the place of a block of the same kind that changed, and nothing when every block renders the same', () => {
    expect(firstRenderedChange('One\n\nTwo here\n\nThree\n', 'One\n\nTwo there\n\nThree\n', md)).toEqual({ line: 3, lastLine: 3 });
    expect(firstRenderedChange('See [a][1].\n\n[1]: http://x.com\n', 'See [a](http://x.com).\n', md)).toBeNull();
  });
});
