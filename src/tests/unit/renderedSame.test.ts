import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { addsExtensionEscape, escapeCounts, rendersSame } from '../../renderer/lib/editor/renderedSame';
import { isLossyMarkdownRoundTrip } from '../../renderer/lib/editor/markdownSync';

const md = new MarkdownIt({ html: true, linkify: false, breaks: false });

describe('escapeCounts', () => {
  it('counts each escaped punctuation character, an escaped backslash once', () => {
    expect([...escapeCounts('\\[a\\] \\* \\\\*')]).toEqual([['[', 1], [']', 1], ['*', 1], ['\\', 1]]);
    expect(escapeCounts('a\\b c\\\n').size).toBe(0);
  });
});

describe('addsExtensionEscape', () => {
  it('flags an escape another app would read differently', () => {
    expect(addsExtensionEscape('[[Page]]', '\\[\\[Page\\]\\]')).toBe(true);
    expect(addsExtensionEscape('#tag', '\\#tag')).toBe(true);
    expect(addsExtensionEscape('==hi==', '\\==hi==')).toBe(true);
  });

  it('lets through escapes the file already had, and escapes of * _ .', () => {
    expect(addsExtensionEscape('\\[x\\]', '\\[x\\]')).toBe(false);
    expect(addsExtensionEscape('5 * 3', '5 \\* 3')).toBe(false);
    expect(addsExtensionEscape('a_b_', 'a\\_b\\_')).toBe(false);
    expect(addsExtensionEscape('Line\n2. x', 'Line\n2\\. x')).toBe(false);
  });
});

describe('rendersSame', () => {
  it('is true for a blank line between blocks, list numbering and a rule\'s spelling', () => {
    expect(rendersSame('Todo:\n- [ ] a', 'Todo:\n\n- [ ] a', md)).toBe(true);
    expect(rendersSame('1. a\n1. b', '1. a\n2. b', md)).toBe(true);
    expect(rendersSame('a\n***\nb', 'a\n\n---\n\nb', md)).toBe(true);
  });

  it('is false when a reference definition goes, even one nothing uses', () => {
    expect(rendersSame('Hello\n\n[1]: http://x.com', 'Hello', md)).toBe(false);
    expect(rendersSame('[a][1]\n\n[1]: http://x.com', '[a](http://x.com)', md)).toBe(false);
  });

  it('is false for a real change', () => {
    expect(rendersSame('a\n<!-- c -->\nb', 'a\n\nb', md)).toBe(false);
    expect(rendersSame('one\ntwo', 'one two', md)).toBe(false);
  });

  it('is false for an escape another app would read differently, though markdown-it renders it the same', () => {
    expect(md.render('[[Page]]')).toBe(md.render('\\[\\[Page\\]\\]'));
    expect(rendersSame('[[Page]]', '\\[\\[Page\\]\\]', md)).toBe(false);
  });
});

describe('isLossyMarkdownRoundTrip with the note\'s parser', () => {
  it('only the parser tells a blank line between blocks from one that changes the note', () => {
    expect(isLossyMarkdownRoundTrip('Text\n# Heading', 'Text\n\n# Heading')).toBe(true);
    expect(isLossyMarkdownRoundTrip('Text\n# Heading', 'Text\n\n# Heading', md)).toBe(false);
    // This blank line ends the paragraph: a real change.
    expect(isLossyMarkdownRoundTrip('one\ntwo', 'one\n\ntwo', md)).toBe(true);
  });
});
