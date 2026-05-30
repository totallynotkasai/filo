import { describe, it, expect } from 'vitest';
import { isMarkdownExtension, normalizeExtension } from '@renderer/lib/vault/extension';

describe('normalizeExtension', () => {
  it('strips a leading dot', () => {
    expect(normalizeExtension('.md')).toBe('md');
    expect(normalizeExtension('.markdown')).toBe('markdown');
  });

  it('lowercases the result', () => {
    expect(normalizeExtension('.MD')).toBe('md');
    expect(normalizeExtension('.Markdown')).toBe('markdown');
    expect(normalizeExtension('PNG')).toBe('png');
  });

  it('passes through dotless input', () => {
    expect(normalizeExtension('md')).toBe('md');
  });

  it('returns empty string for null / undefined / empty', () => {
    expect(normalizeExtension(null)).toBe('');
    expect(normalizeExtension(undefined)).toBe('');
    expect(normalizeExtension('')).toBe('');
  });

  it('only strips the first leading dot (preserves trailing structure)', () => {
    expect(normalizeExtension('..md')).toBe('.md');
  });
});

describe('isMarkdownExtension', () => {
  it('accepts dotted `.md` (vault sidebar form via Node extname)', () => {
    expect(isMarkdownExtension('.md')).toBe(true);
  });

  it('accepts dotted `.markdown`', () => {
    expect(isMarkdownExtension('.markdown')).toBe(true);
  });

  it('accepts dotless `md` (OS-file split form)', () => {
    expect(isMarkdownExtension('md')).toBe(true);
  });

  it('accepts dotless `markdown`', () => {
    expect(isMarkdownExtension('markdown')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMarkdownExtension('.MARKDOWN')).toBe(true);
    expect(isMarkdownExtension('.Md')).toBe(true);
    expect(isMarkdownExtension('MD')).toBe(true);
  });

  it('rejects non-markdown extensions', () => {
    expect(isMarkdownExtension('.txt')).toBe(false);
    expect(isMarkdownExtension('png')).toBe(false);
    expect(isMarkdownExtension('.mdx')).toBe(false);
  });

  it('rejects null / undefined / empty', () => {
    expect(isMarkdownExtension(null)).toBe(false);
    expect(isMarkdownExtension(undefined)).toBe(false);
    expect(isMarkdownExtension('')).toBe(false);
  });
});
