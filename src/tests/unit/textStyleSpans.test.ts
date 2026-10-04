import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '@renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '@renderer/lib/editor/markdownSync';
import { carriesKeptTextStyle } from '@renderer/lib/editor/textStyleSpans';

/**
 * A `<span>` becomes a text-style mark only when it sets a colour, font or
 * size, and a text-style mark that sets nothing is never written as a bare
 * `<span>` (which reads back as plain text, so the note would open read-only).
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  return ed;
}

function span(style: string): HTMLElement {
  const el = document.createElement('span');
  el.setAttribute('style', style);
  return el;
}

describe('carriesKeptTextStyle', () => {
  it('is true for a colour, a font family or a font size', () => {
    expect(carriesKeptTextStyle(span('color: #c81e1e'))).toBe(true);
    expect(carriesKeptTextStyle(span('font-family: Georgia'))).toBe(true);
    expect(carriesKeptTextStyle(span('font-size: 18px'))).toBe(true);
  });

  it('is false for any other style', () => {
    expect(carriesKeptTextStyle(span('mso-spacerun: yes'))).toBe(false);
    expect(carriesKeptTextStyle(span('font-weight: bold'))).toBe(false);
    expect(carriesKeptTextStyle(span('text-decoration: underline'))).toBe(false);
    expect(carriesKeptTextStyle(span('white-space: pre'))).toBe(false);
  });
});

describe('the text-style mark in a note', () => {
  it('a styled span that sets no kept style loads as plain text', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'The <span style="text-decoration: underline">dragon</span> slept.');
    const marks = ed.state.doc.firstChild?.child(1).marks.map((m) => m.type.name) ?? [];
    expect(marks).not.toContain('textStyle');
  });

  it('a mark that sets nothing writes no bare <span>', () => {
    const ed = makeEditor();
    loadMarkdownIntoEditor(ed, 'Plain words here.');
    ed.chain().setTextSelection({ from: 7, to: 12 }).setMark('textStyle', {}).run();
    const disk = editorMarkdown(ed);
    expect(disk).toBe('Plain words here.');
    expect(loadMarkdownIntoEditor(makeEditor(), disk).lossy).toBe(false);
  });

  it('a coloured span (as Filo writes one) is still written, and reopens as the same', () => {
    const note = 'A <span style="color: rgb(200, 30, 30);">red</span> word.';
    const ed = makeEditor();
    expect(loadMarkdownIntoEditor(ed, note).lossy).toBe(false);
    expect(editorMarkdown(ed)).toBe(note);
  });
});
