import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createLabelEditor, createTiptapEditor } from '@renderer/lib/editor/createEditor';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import { editorMarkdown, loadMarkdownIntoEditor } from '@renderer/lib/editor/markdownSync';
import { applyLink, linkAllowedAt, linkTargetAt, removeLink } from '@renderer/lib/editor/insertLink';
import { clearBlockTextStyle } from '@renderer/lib/editor/blockTextStyle';

/**
 * The Insert Link popup's editor side. `setLink` over a bare caret only sets a
 * stored mark, so a link inserted with nothing selected used to insert
 * nothing, silently.
 */

const editors: Editor[] = [];
function makeEditor(body: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, body);
  return ed;
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

describe('linkTargetAt', () => {
  it('a bare caret targets an empty range with no text', () => {
    const ed = makeEditor('Alpha beta');
    ed.commands.setTextSelection(3);
    expect(linkTargetAt(ed)).toEqual({ from: 3, to: 3, text: '', href: '' });
  });

  it('a selection targets itself and pre-fills its text', () => {
    const ed = makeEditor('Alpha beta');
    ed.commands.setTextSelection({ from: 7, to: 11 });
    expect(linkTargetAt(ed)).toEqual({ from: 7, to: 11, text: 'beta', href: '' });
  });

  it('a caret inside a link targets the whole link', () => {
    const ed = makeEditor('Alpha [beta](https://example.com) gamma');
    ed.commands.setTextSelection(9);
    expect(linkTargetAt(ed)).toEqual({ from: 7, to: 11, text: 'beta', href: 'https://example.com' });
  });

  it('a caret right after a link targets that link', () => {
    const ed = makeEditor('Alpha [beta](https://example.com) gamma');
    ed.commands.setTextSelection(11);
    expect(linkTargetAt(ed)).toEqual({ from: 7, to: 11, text: 'beta', href: 'https://example.com' });
  });

  it('a caret right before a link is where a new link goes', () => {
    const ed = makeEditor('Alpha [beta](https://example.com) gamma');
    ed.commands.setTextSelection(7);
    expect(linkTargetAt(ed)).toEqual({ from: 7, to: 7, text: '', href: '' });
  });

  it('a caret before a link that opens the paragraph is where a new link goes', () => {
    const ed = makeEditor('[beta](https://example.com) gamma');
    ed.commands.setTextSelection(1);
    expect(linkTargetAt(ed)).toEqual({ from: 1, to: 1, text: '', href: '' });
  });

  it('a caret between two links targets the one before it', () => {
    const ed = makeEditor('[one](https://one.example)[two](https://two.example)');
    ed.commands.setTextSelection(4);
    expect(linkTargetAt(ed)).toEqual({ from: 1, to: 4, text: 'one', href: 'https://one.example' });
  });

  it('a selection within a link targets the whole link', () => {
    const ed = makeEditor('Alpha [beta](https://example.com) gamma');
    ed.commands.setTextSelection({ from: 8, to: 10 });
    expect(linkTargetAt(ed)).toMatchObject({ from: 7, to: 11, href: 'https://example.com' });
  });
});

describe('applyLink', () => {
  it('with an empty Text field at a bare caret, inserts the URL as the link text', () => {
    const ed = makeEditor('Alpha');
    ed.commands.setTextSelection(6);
    expect(applyLink(ed, linkTargetAt(ed), '', 'https://example.com')).toBe(true);
    // An autolink is how Markdown writes a link whose text is its URL.
    expect(editorMarkdown(ed)).toBe('Alpha<https://example.com>');
  });

  it('typing after an inserted link does not extend it', () => {
    const ed = makeEditor('Alpha');
    ed.commands.setTextSelection(6);
    applyLink(ed, linkTargetAt(ed), 'site', 'https://example.com');
    ed.commands.insertContent(' more');
    expect(editorMarkdown(ed)).toBe('Alpha[site](https://example.com) more');
  });

  it('with an empty Text field over a selection, keeps the selected text', () => {
    const ed = makeEditor('Alpha beta');
    ed.commands.setTextSelection({ from: 7, to: 11 });
    applyLink(ed, linkTargetAt(ed), '', 'https://example.com');
    expect(editorMarkdown(ed)).toBe('Alpha [beta](https://example.com)');
  });

  it('refuses a javascript: href and changes nothing', () => {
    const ed = makeEditor('Alpha');
    ed.commands.setTextSelection(6);
    expect(applyLink(ed, linkTargetAt(ed), 'x', 'javascript:alert(1)')).toBe(false);
    expect(editorMarkdown(ed)).toBe('Alpha');
  });

  it('a new link at a caret right before a link leaves that link alone', () => {
    const ed = makeEditor('Alpha [beta](https://example.com) gamma');
    ed.commands.setTextSelection(7);
    expect(applyLink(ed, linkTargetAt(ed), 'new ', 'https://new.example')).toBe(true);
    // The space ending the typed text stays outside the new link (Link drops a link's trailing whitespace).
    expect(editorMarkdown(ed)).toBe('Alpha [new](https://new.example) [beta](https://example.com) gamma');
  });

  it('refuses a code block, changing nothing', () => {
    const ed = makeEditor('```\ncode here\n```');
    ed.commands.setTextSelection({ from: 1, to: 5 });
    const target = linkTargetAt(ed);
    expect(linkAllowedAt(ed, target)).toBe(false);
    expect(applyLink(ed, target, '', 'https://example.com')).toBe(false);
    expect(editorMarkdown(ed)).toBe('```\ncode here\n```');
  });

  it('checks the place at the target, not wherever the selection moved to', () => {
    const ed = makeEditor('Alpha beta\n\n```\ncode\n```');
    ed.commands.setTextSelection({ from: 7, to: 11 });
    const target = linkTargetAt(ed);
    // The selection moves into the code block while the popup is open.
    ed.commands.setTextSelection(14);
    expect(linkAllowedAt(ed, target)).toBe(true);
    expect(applyLink(ed, target, '', 'https://example.com')).toBe(true);
    expect(editorMarkdown(ed)).toBe('Alpha [beta](https://example.com)\n\n```\ncode\n```');
  });

  it('changes nothing in a read-only editor', () => {
    const ed = makeEditor('Alpha');
    ed.setEditable(false, false);
    ed.commands.setTextSelection(6);
    expect(applyLink(ed, { from: 6, to: 6, text: '', href: '' }, 'x', 'https://example.com')).toBe(false);
    expect(editorMarkdown(ed)).toBe('Alpha');
  });

  it('a target past the end of a document that shrank meanwhile is clamped', () => {
    const ed = makeEditor('Alpha beta gamma');
    const target = { from: 12, to: 17, text: 'gamma', href: '' };
    loadMarkdownIntoEditor(ed, 'Hi');
    expect(applyLink(ed, target, 'x', 'https://example.com')).toBe(true);
    expect(editorMarkdown(ed)).toBe('Hi[x](https://example.com)');
  });
});

describe('title and label editors', () => {
  function makeLabelEditor(): Editor {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const ed = createLabelEditor({ element: el, content: '<p>Label</p>' });
    editors.push(ed);
    return ed;
  }

  it('applyLink refuses, rather than throwing on the missing setLink command', () => {
    const ed = makeLabelEditor();
    expect(applyLink(ed, { from: 1, to: 6, text: 'Label', href: '' }, 'Label', 'https://example.com')).toBe(false);
    expect(ed.getHTML()).toBe('<p>Label</p>');
  });

  it('the heading dropdown does nothing, rather than throwing on the missing setHeading command', () => {
    const ed = makeLabelEditor();
    tiptapToolbar.setActiveEditor(ed);
    expect(tiptapToolbar.setHeading(2)).toBe(false);
    expect(tiptapToolbar.setHeading(0)).toBe(false);
    expect(ed.getHTML()).toBe('<p>Label</p>');
    tiptapToolbar.clearActiveEditor();
  });
});

describe('removeLink', () => {
  it('removes the whole link and keeps its text', () => {
    const ed = makeEditor('Alpha [beta](https://example.com) gamma');
    ed.commands.setTextSelection(9);
    removeLink(ed, linkTargetAt(ed));
    expect(editorMarkdown(ed)).toBe('Alpha beta gamma');
  });
});

describe('heading dropdown clears inline text style', () => {
  it('a heading drops the block font size, family and colour but keeps bold and links', () => {
    const ed = makeEditor(
      'A <span style="font-size: 20px; font-family: Georgia; color: #ff0000">b</span> **c** [d](https://example.com)\n\nOther <span style="font-size: 20px">e</span>',
    );
    ed.commands.setTextSelection(2);
    ed.chain().command(clearBlockTextStyle).setHeading({ level: 4 }).run();
    const md = editorMarkdown(ed);
    expect(md.split('\n\n')[0]).toBe('#### A b **c** [d](https://example.com)');
    // The next block was not touched.
    expect(md.split('\n\n')[1]).toContain('font-size: 20px');
  });

  it('clears every block a selection touches, whole', () => {
    const ed = makeEditor('<span style="font-size: 20px">One</span>\n\n<span style="font-size: 20px">Two</span>');
    ed.commands.setTextSelection({ from: 3, to: 7 });
    ed.chain().command(clearBlockTextStyle).setHeading({ level: 2 }).run();
    expect(editorMarkdown(ed)).toBe('## One\n\n## Two');
  });
});
