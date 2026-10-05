import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { MarkdownSerializer } from 'prosemirror-markdown';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { serializeNote } from '../../renderer/lib/editor/noteSerializerState';
import {
  LONG_NOTE_SERIALIZE_IDLE_MS,
  LONG_NOTE_SIZE,
  SERIALIZE_IDLE_MS,
  serializeIdleMs,
} from '../../renderer/lib/editor/noteEditorView';

/**
 * The note serializer state writes exactly what prosemirror-markdown's own
 * state writes; it only keeps the output's last characters at hand, so a
 * long note saves in time that grows with its length, not its square.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

type Specs = ConstructorParameters<typeof MarkdownSerializer>;

function editorWith(markdown: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, markdown);
  return ed;
}

function specsOf(ed: Editor): { nodes: Specs[0]; marks: Specs[1] } {
  const storage = ed.storage as unknown as { markdown: { serializer: { nodes: Specs[0]; marks: Specs[1] } } };
  return storage.markdown.serializer;
}

/** The same document written by prosemirror-markdown's state and by the note state. */
function bothWays(ed: Editor, doc: ProseMirrorNode = ed.state.doc): { theirs: string; ours: string } {
  const { nodes, marks } = specsOf(ed);
  const options = { hardBreakNodeName: 'hardBreak' };
  return {
    theirs: new MarkdownSerializer(nodes, marks, options).serialize(doc),
    ours: serializeNote(doc, nodes, marks, options).text,
  };
}

const NOTES: Record<string, string> = {
  prose: 'First paragraph with *italic* and **bold**.\n\nSecond paragraph.\n\n\n\nAfter two empty lines.',
  quotes: '> A quote\n> over lines\n>\n> > nested\n\nAfter.',
  lists: '- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] task\n- [x] done',
  breaks: 'Line one\\\nline two\nline three',
  'a link after an exclamation mark': 'Wow![a link](https://example.com) and done!\n\nNext',
  'an image': '![map](images/map.png) and text',
  table: '| a | b |\n| --- | --- |\n| 1 | 2 |',
  code: '```js\nlet x = 1\n```\n\nAfter code.',
  headings: '# Title\n\n## Sub\n\nText\n\n---\n\nEnd',
  'html lines': '<p style="text-align: center;">Centred</p>\n\nText <span style="color: rgb(255, 0, 0);">red</span>.',
  'lead spaces and tabs': '&#32;lead space\n\n&#9;tab first',
};

describe('the note serializer state', () => {
  for (const [name, markdown] of Object.entries(NOTES)) {
    it(`writes ${name} as prosemirror-markdown's own state does`, () => {
      const { theirs, ours } = bothWays(editorWith(markdown));
      expect(ours).toBe(theirs);
    });
  }

  it('writes a long note as prosemirror-markdown\'s own state does', () => {
    const para = 'He waited… and *waited*, counting the **bells** of the old tower.';
    const markdown = Array.from({ length: 300 }, (_, i) => (i % 25 === 24 ? '> quoted' : para)).join('\n\n');
    const { theirs, ours } = bothWays(editorWith(markdown));
    expect(ours).toBe(theirs);
  });
});

describe('how soon a note editor saves after typing stops', () => {
  it('after the usual idle time for a note of ordinary length', () => {
    expect(serializeIdleMs(editorWith('A short note.'))).toBe(SERIALIZE_IDLE_MS);
    expect(serializeIdleMs(null)).toBe(SERIALIZE_IDLE_MS);
  });

  it('after a longer pause for a note of about 20,000 words or more', () => {
    const long = Array.from({ length: Math.ceil(LONG_NOTE_SIZE / 40) }, () => 'Fifty-odd characters of prose in one short paragraph.').join('\n\n');
    expect(serializeIdleMs(editorWith(long))).toBe(LONG_NOTE_SERIALIZE_IDLE_MS);
  });
});
