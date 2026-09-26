/**
 * A frontmatter-only change rewrites the frontmatter block and nothing else.
 *
 * - The note writer keeps the body byte-exact, line endings included, in a
 *   file whose lines are mixed; the block keeps the ending it already has.
 * - The tag rewriter keeps the body, the fence lines (`--- `) and the lack of
 *   a final newline as they were.
 * - Both pick line endings with one shared rule.
 */
import { describe, it, expect } from 'vitest';
import { assembleNoteText, readNoteText } from '../../renderer/lib/notes/noteFile';
import { addTagToMarkdown, removeTagFromMarkdown, rewriteTagInMarkdown } from '../../renderer/lib/vault/tagRewriter';
import { fileLineEnding, frontmatterLineEnding } from '../../renderer/lib/utils/lineEnding';

const bodyOf = (text: string): string => readNoteText(text).body;

describe('the note writer on a mixed-line-ending file', () => {
  const mixed = '---\r\ntitle: A\r\n---\r\nline one\nline two\r\nline three\n';

  it('a frontmatter change leaves every body byte as it was', () => {
    const out = assembleNoteText(readNoteText(mixed), { delta: { set: { status: 'open' }, unset: [] } });
    expect(out).toBe('---\r\ntitle: A\r\nstatus: open\r\n---\r\nline one\nline two\r\nline three\n');
    expect(bodyOf(out)).toBe(bodyOf(mixed));
  });

  it('an LF block over a body with one CRLF line stays LF', () => {
    const text = '---\ntitle: A\n---\nline one\r\nline two\n';
    const out = assembleNoteText(readNoteText(text), { delta: { set: { status: 'open' }, unset: [] } });
    expect(out).toBe('---\ntitle: A\nstatus: open\n---\nline one\r\nline two\n');
  });

  it('a body without a final newline, and a note without frontmatter, keep their bytes', () => {
    const noFinal = '---\ntitle: A\n---\nline one\r\nline two';
    expect(assembleNoteText(readNoteText(noFinal), { delta: { set: { status: 'open' }, unset: [] } })).toBe(
      '---\ntitle: A\nstatus: open\n---\nline one\r\nline two',
    );
    const bare = 'line one\nline two\r\n';
    const out = assembleNoteText(readNoteText(bare), { delta: { set: { status: 'open' }, unset: [] } });
    expect(bodyOf(out)).toBe(bare);
  });

  it('a new body gets the file\'s majority line ending, not "any CRLF"', () => {
    const mostlyLf = '---\ntitle: A\n---\none\ntwo\r\nthree\nfour\n';
    expect(readNoteText(mostlyLf).eol).toBe('\n');
    const out = assembleNoteText(readNoteText(mostlyLf), { body: 'one\ntwo' });
    expect(out).toBe('---\ntitle: A\n---\none\ntwo\n');
    const crlf = '---\r\ntitle: A\r\n---\r\none\r\ntwo\r\n';
    expect(assembleNoteText(readNoteText(crlf), { body: 'one\nthree' })).toBe('---\r\ntitle: A\r\n---\r\none\r\nthree\r\n');
  });
});

describe('the tag rewriter touches only `tags:`', () => {
  it('keeps a body without a final newline as it was', () => {
    const src = '---\ntags:\n  - a\n---\nbody without newline';
    expect(addTagToMarkdown(src, 'b')).toBe('---\ntags:\n  - a\n  - b\n---\nbody without newline');
    expect(removeTagFromMarkdown(src, 'a').endsWith('---\nbody without newline')).toBe(true);
  });

  it('keeps fence lines with trailing spaces, and no newline after the closing fence', () => {
    const src = '--- \ntags: [a, b]\n---  ';
    expect(rewriteTagInMarkdown(src, 'a', 'c')).toBe('--- \ntags: [c, b]\n---  ');
  });

  it('keeps a mixed-line-ending body byte-exact and the block in its own ending', () => {
    const src = '---\r\ntags: [a]\r\n---\r\nline one\nline two\r\n';
    const out = addTagToMarkdown(src, 'b');
    expect(out.startsWith('---\r\n')).toBe(true);
    expect(out.endsWith('---\r\nline one\nline two\r\n')).toBe(true);
    // An LF block keeps LF even when a body line is CRLF.
    const lfBlock = '---\ntags: [a]\n---\r\nline one\r\nline two\r\n';
    expect(rewriteTagInMarkdown(lfBlock, 'a', 'b')).toBe('---\ntags: [b]\n---\r\nline one\r\nline two\r\n');
  });

  it('a new block on a note without one uses the file\'s line ending', () => {
    expect(addTagToMarkdown('one\r\ntwo\r\n', 'a')).toBe('---\r\ntags:\r\n  - a\r\n---\r\none\r\ntwo\r\n');
    expect(addTagToMarkdown('one\ntwo', 'a')).toBe('---\ntags:\n  - a\n---\none\ntwo');
  });
});

describe('the shared line-ending rule', () => {
  it('a file is CRLF by majority, and a block keeps its fence\'s ending', () => {
    expect(fileLineEnding('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(fileLineEnding('a\nb\nc\r\n')).toBe('\n');
    expect(fileLineEnding('no break')).toBe('\n');
    expect(frontmatterLineEnding('---\ntitle: A\n---\r\nbody\r\nmore\r\n')).toBe('\n');
    expect(frontmatterLineEnding(`${String.fromCharCode(0xfeff)}---\r\ntitle: A\r\n---\nbody\n`)).toBe('\r\n');
    expect(frontmatterLineEnding('body\r\nmore\r\n')).toBe('\r\n');
  });
});
