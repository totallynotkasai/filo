import { describe, it, expect } from 'vitest';
import { splitFrontmatterFence, openingFenceEol } from '../../renderer/lib/notes/frontmatterFence';
import { parseMarkdownFile } from '../../renderer/lib/editor/markdownSync';
import { splitFrontmatterSource } from '../../renderer/lib/vault/frontmatterRead';
import { addTagToMarkdown } from '../../renderer/lib/vault/tagRewriter';

const BOM = String.fromCharCode(0xfeff);

describe('splitFrontmatterFence', () => {
  it('splits an LF block', () => {
    expect(splitFrontmatterFence('---\ntitle: A\n---\nBody\n')).toEqual({
      hadBom: false,
      block: { open: '---', openEol: '\n', source: 'title: A', close: '---', closeEol: '\n' },
      body: 'Body\n',
    });
  });

  it('splits a CRLF block and keeps the body verbatim', () => {
    const s = splitFrontmatterFence('---\r\ntitle: A\r\ntags: [x]\r\n---\r\nOne\r\nTwo\n');
    expect(s.block).toEqual({ open: '---', openEol: '\r\n', source: 'title: A\r\ntags: [x]', close: '---', closeEol: '\r\n' });
    expect(s.body).toBe('One\r\nTwo\n');
  });

  it('skips a BOM and reports it', () => {
    const s = splitFrontmatterFence(`${BOM}---\r\ntitle: A\r\n---\r\nBody`);
    expect(s.hadBom).toBe(true);
    expect(s.block?.source).toBe('title: A');
    expect(s.body).toBe('Body');
  });

  it('keeps trailing spaces on the fence lines', () => {
    const s = splitFrontmatterFence('--- \ntitle: A\n---\t\nBody');
    expect(s.block).toMatchObject({ open: '--- ', close: '---\t', source: 'title: A' });
    expect(s.body).toBe('Body');
  });

  it('reads an empty fence pair as an empty block', () => {
    expect(splitFrontmatterFence('---\n---\nBody').block).toMatchObject({ source: '' });
    expect(splitFrontmatterFence('---\r\n---\r\nBody').body).toBe('Body');
    expect(splitFrontmatterFence('---\n\n---\nBody').block?.source).toBe('');
  });

  it('closes an empty block at the first fence, not at a later rule in the body', () => {
    const s = splitFrontmatterFence('---\n---\ntitle: in body\n\n---\nMore\n');
    expect(s.block?.source).toBe('');
    expect(s.body).toBe('title: in body\n\n---\nMore\n');
  });

  it('closes a block at the first column-0 fence', () => {
    const s = splitFrontmatterFence('---\na: 1\n---\nBody\n\n---\nAfter rule\n');
    expect(s.block?.source).toBe('a: 1');
    expect(s.body).toBe('Body\n\n---\nAfter rule\n');
  });

  it('accepts a closing fence at the end of the file', () => {
    const s = splitFrontmatterFence('---\na: 1\n---');
    expect(s.block).toMatchObject({ source: 'a: 1', closeEol: '' });
    expect(s.body).toBe('');
    expect(splitFrontmatterFence('---\n---').block?.source).toBe('');
  });

  it('keeps trailing blank lines of the block in the source', () => {
    // A `|+` block scalar's trailing blank lines are part of its value.
    expect(splitFrontmatterFence('---\nnotes: |+\n  x\n\n\n---\nB').block?.source).toBe('notes: |+\n  x\n\n');
  });

  it('does not take `----` or `--- text` as a closing fence', () => {
    expect(splitFrontmatterFence('---\na: 1\n----\nBody').block).toBeNull();
    expect(splitFrontmatterFence('---\na: 1\n--- x\nBody').block).toBeNull();
    const later = splitFrontmatterFence('---\na: 1\n----\nb: 2\n---\nBody');
    expect(later.block?.source).toBe('a: 1\n----\nb: 2');
  });

  it('does not treat `...` as a closing fence', () => {
    expect(splitFrontmatterFence('---\na: 1\n...\nBody').block).toBeNull();
  });

  it('returns the whole text as body when there is no block', () => {
    expect(splitFrontmatterFence('')).toEqual({ hadBom: false, block: null, body: '' });
    expect(splitFrontmatterFence(BOM)).toEqual({ hadBom: true, block: null, body: '' });
    expect(splitFrontmatterFence('# Title\n---\n')).toEqual({ hadBom: false, block: null, body: '# Title\n---\n' });
    // An opening fence with no closing one is body (a torn or unfinished block).
    expect(splitFrontmatterFence('---\ntitle: A\nBody').block).toBeNull();
    // A lone `---` line with no line break is not an opening fence.
    expect(splitFrontmatterFence('---').block).toBeNull();
    // Leading whitespace before the fence is not frontmatter.
    expect(splitFrontmatterFence(' ---\na: 1\n---\n').block).toBeNull();
  });

  it('gives back every byte: BOM + fences + source + body is the input', () => {
    const cases = [
      '---\ntitle: A\n---\nBody\n',
      `${BOM}--- \r\ntitle: A\r\n# c\r\n---  \r\nOne\nTwo\r\n`,
      '---\n---\n',
      '---\na: 1\n---',
      '---\n\n---\nx',
      '---\r\na: 1\n---\nmixed\r\n',
    ];
    for (const raw of cases) {
      const s = splitFrontmatterFence(raw);
      const b = s.block;
      expect(b).not.toBeNull();
      if (!b) continue;
      // The interior line break before the closing fence is whatever the file had.
      const text = s.hadBom ? raw.slice(1) : raw;
      const before = `${b.open}${b.openEol}`;
      const after = `${b.close}${b.closeEol}${s.body}`;
      expect(text.startsWith(before)).toBe(true);
      expect(text.endsWith(after)).toBe(true);
      const interior = text.slice(before.length, text.length - after.length);
      expect(interior === '' || interior === `${b.source}\n` || interior === `${b.source}\r\n`).toBe(true);
    }
  });
});

describe('openingFenceEol', () => {
  it('reads the opening fence line break, with or without a closing fence', () => {
    expect(openingFenceEol('---\na: 1\n---\n')).toBe('\n');
    expect(openingFenceEol('--- \r\na: 1')).toBe('\r\n');
    expect(openingFenceEol(`${BOM}---\r\n`)).toBe('\r\n');
    expect(openingFenceEol('Body\n---\n')).toBeNull();
    expect(openingFenceEol('---')).toBeNull();
    expect(openingFenceEol('----\n')).toBeNull();
  });
});

describe('every reader agrees on the block', () => {
  const cases = [
    '---\n---\ntitle: in body\n\n---\nMore\n',
    '---\ntitle: A\n---\nBody\n',
    `${BOM}---\r\ntitle: A\r\n---\r\nBody`,
    '--- \ntitle: A\n---\t\nBody',
    '---\na: 1\n----\nBody',
    'No block\n---\n',
  ];

  it('parseMarkdownFile and splitFrontmatterSource see the same source and body', () => {
    for (const raw of cases) {
      const parsed = parseMarkdownFile(raw);
      const indexed = splitFrontmatterSource(raw);
      expect(indexed.rawFrontmatter).toBe(parsed.rawFrontmatter);
      expect(indexed.body).toBe(parsed.body);
    }
  });

  it('the index no longer reads a key from the body after an empty block', () => {
    const raw = '---\n---\ntitle: in body\n---\nMore\n';
    expect(splitFrontmatterSource(raw).rawFrontmatter).toBe('');
    expect(parseMarkdownFile(raw).frontmatter).toEqual({});
  });

  it('a tag add writes into the empty first block and leaves the body as it was', () => {
    const raw = '---\n---\ntitle: in body\n---\nMore\n';
    const out = addTagToMarkdown(raw, 'x');
    const after = splitFrontmatterFence(out);
    expect(after.body).toBe('title: in body\n---\nMore\n');
    expect(parseMarkdownFile(out).frontmatter).toEqual({ tags: ['x'] });
  });
});
