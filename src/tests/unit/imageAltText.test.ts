import { describe, it, expect, afterEach } from 'vitest';
import MarkdownIt from 'markdown-it';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { renderNotePreviewHtml } from '../../renderer/lib/editor/staticPreview';
import { keepEscapedCharactersInImageAlt } from '../../renderer/lib/editor/imageAlt';

/**
 * An image's alt text keeps the characters a backslash escapes in it. The
 * writer escapes `[`, `]` and `*` in alt text, and markdown-it's alt text
 * skipped the escape tokens, so `![Aria \[sketch\]](x)` reopened as
 * "Aria sketch": silently, as both sides rendered alike, and the next save
 * wrote the brackets away.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function editorWith(md: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, md);
  return ed;
}

function alts(ed: Editor): string[] {
  const out: string[] = [];
  ed.state.doc.descendants((n) => {
    if (n.type.name === 'image') out.push(String(n.attrs.alt));
  });
  return out;
}

describe('image alt text across a save', () => {
  it('loads escaped brackets and asterisks as the characters', () => {
    expect(alts(editorWith('![Aria \\[sketch\\]](images/aria.png)\n'))).toEqual(['Aria [sketch]']);
    expect(alts(editorWith('![Rating 5\\* map](x.png)\n'))).toEqual(['Rating 5* map']);
    expect(alts(editorWith('![a \\\\ b](x.png)\n'))).toEqual(['a \\ b']);
  });

  it('an edit on the line keeps the alt text', () => {
    const ed = editorWith('Aria at the ford: ![Aria [sketch]](images/aria.png)\n');
    expect(alts(ed)).toEqual(['Aria [sketch]']);
    ed.commands.setTextSelection(ed.state.doc.content.size - 1);
    ed.commands.insertContent(' (draft)');
    const saved = editorMarkdown(ed);
    expect(alts(editorWith(saved))).toEqual(['Aria [sketch]']);
  });

  it('a pasted web image whose alt has an asterisk or brackets', () => {
    const ed = editorWith('Before\n');
    ed.commands.setTextSelection(ed.state.doc.content.size - 1);
    ed.commands.insertContent('<img src="images/x.png" alt="Rating 5* map [v2]">');
    const saved = editorMarkdown(ed);
    expect(alts(editorWith(saved))).toEqual(['Rating 5* map [v2]']);
  });

  it('an image inside a link keeps its alt text too', () => {
    expect(alts(editorWith('[![Map \\[old\\]](m.png)](https://example.com)\n'))).toEqual(['Map [old]']);
  });

  it('a card preview shows the same alt text', () => {
    expect(renderNotePreviewHtml('![Aria \\[sketch\\] 5\\*](images/aria.png)\n', 'Notes/A.md')).toContain('alt="Aria [sketch] 5*"');
  });
});

describe('keepEscapedCharactersInImageAlt', () => {
  it('reads as CommonMark does: an escape in alt text is its character', () => {
    const md = new MarkdownIt();
    keepEscapedCharactersInImageAlt(md);
    expect(md.renderInline('![a \\[b\\] \\* c](x.png)')).toBe('<img src="x.png" alt="a [b] * c">');
  });

  it('leaves text outside images alone', () => {
    const md = new MarkdownIt();
    const before = md.render('a \\[b\\] \\*c\\* ![x](y.png)\n');
    keepEscapedCharactersInImageAlt(md);
    expect(md.render('a \\[b\\] \\*c\\* ![x](y.png)\n')).toBe(before);
  });

  it('is added once however often it is called', () => {
    const md = new MarkdownIt();
    keepEscapedCharactersInImageAlt(md);
    keepEscapedCharactersInImageAlt(md);
    expect(md.core.ruler.getRules('').length).toBe(new MarkdownIt().core.ruler.getRules('').length + 1);
  });
});
