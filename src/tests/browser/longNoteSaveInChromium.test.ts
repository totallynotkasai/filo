import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';

/**
 * A long note's save costs time in step with its length. The serializer
 * re-read its whole output at every block, so the save after each typing
 * pause grew with the square of the note: 4 ms at 10,000 words, 75 ms at
 * 40,000, close to a second at 100,000 (a whole manuscript in one note).
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

/** About `words` words of prose with italics and bold, in paragraphs of four sentences, a quote now and then. */
function prose(words: number): string {
  const sentences = [
    '“I don’t know,” she said, *quietly*, and turned to the window.',
    'The rain had not stopped for three days—not once.',
    'He waited… and waited, counting the **bells** of the old tower.',
    'Nothing moved in the valley below, save the river and the crows.',
  ];
  const paras: string[] = [];
  let count = 0;
  for (let i = 0; count < words; ) {
    const para: string[] = [];
    for (let k = 0; k < 4; k++) {
      const s = sentences[i++ % sentences.length] ?? '';
      para.push(s);
      count += s.split(' ').length;
    }
    paras.push(paras.length % 30 === 29 ? `> ${para.join(' ')}` : para.join(' '));
  }
  return paras.join('\n\n');
}

/** The editor's save of its note, timed: the best of three after a warm-up. */
function saveMs(words: number): number {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  const body = prose(words);
  expect(loadMarkdownIntoEditor(ed, body).lossy).toBe(false);
  expect(editorMarkdown(ed)).toBe(body);
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    editorMarkdown(ed);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('saving a long note', () => {
  it('takes time in step with the note\'s length, well under a second at 100,000 words', () => {
    const at20k = saveMs(20_000);
    const at100k = saveMs(100_000);
    // Five times the words: about five times the time when linear, about 25 when quadratic.
    expect(at100k / Math.max(at20k, 1)).toBeLessThan(12);
    expect(at100k).toBeLessThan(500);
  }, 120_000);
});
