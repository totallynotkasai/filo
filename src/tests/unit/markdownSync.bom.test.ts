import { describe, it, expect } from 'vitest';
import {
  parseMarkdownFile,
  assembleMarkdownFile,
} from '../../renderer/lib/editor/markdownSync';

/**
 * BOM-prefixed `.md` files (Notepad, legacy Office "Save
 * As UTF-8") were losing their frontmatter because the regex anchored to
 * `^---` after the BOM byte. `parseMarkdownFile` now strips the leading
 * BOM and exposes `hadBom: boolean` so callers can opt into re-emission
 * via `assembleMarkdownFile({ bom: true })`.
 */

const BOM = '﻿';

describe('markdownSync — BOM handling', () => {
  it('parses BOM + frontmatter (acceptance case)', () => {
    const raw = `${BOM}---\ntags: [x]\n---\nhello`;
    const r = parseMarkdownFile(raw);
    expect(r.frontmatter).toEqual({ tags: ['x'] });
    expect(r.body).toBe('hello');
    expect(r.hasFrontmatter).toBe(true);
    expect(r.hadBom).toBe(true);
  });

  it('parses BOM + no-frontmatter body', () => {
    const raw = `${BOM}# heading\n\nbody`;
    const r = parseMarkdownFile(raw);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('# heading\n\nbody');
    expect(r.hasFrontmatter).toBe(false);
    expect(r.hadBom).toBe(true);
  });

  it('parses no-BOM + frontmatter (control case — hadBom is false)', () => {
    const raw = '---\ntitle: Foo\n---\nbody';
    const r = parseMarkdownFile(raw);
    expect(r.frontmatter).toEqual({ title: 'Foo' });
    expect(r.body).toBe('body');
    expect(r.hasFrontmatter).toBe(true);
    expect(r.hadBom).toBe(false);
  });

  it('round-trips BOM through parse → assemble with bom option', () => {
    const raw = `${BOM}---\ntitle: Foo\ntags: [a, b]\n---\nhello`;
    const parsed = parseMarkdownFile(raw);
    const out = assembleMarkdownFile(parsed.frontmatter, parsed.body, {
      bom: parsed.hadBom,
    });
    // Re-parse the output: BOM should survive, frontmatter intact.
    const reparsed = parseMarkdownFile(out);
    expect(reparsed.hadBom).toBe(true);
    expect(reparsed.frontmatter).toEqual({ title: 'Foo', tags: ['a', 'b'] });
    expect(reparsed.body.trimEnd()).toBe('hello');
    // The raw bytes must start with the BOM character.
    expect(out.charCodeAt(0)).toBe(0xfeff);
  });

  it('parses empty input without crashing — hadBom defaults to false', () => {
    const r = parseMarkdownFile('');
    expect(r).toEqual({ frontmatter: {}, rawFrontmatter: '', body: '', hasFrontmatter: false, hadBom: false });
  });

  it('parses BOM-only input (no body, no frontmatter)', () => {
    const r = parseMarkdownFile(BOM);
    expect(r.hadBom).toBe(true);
    expect(r.hasFrontmatter).toBe(false);
    expect(r.body).toBe('');
    expect(r.frontmatter).toEqual({});
  });
});

describe('markdownSync — assembleMarkdownFile bom option', () => {
  it('does NOT emit a BOM by default', () => {
    const out = assembleMarkdownFile({ title: 'Foo' }, 'body');
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
    expect(out.startsWith('---\n')).toBe(true);
  });

  it('emits a BOM when bom: true is passed (no-frontmatter branch)', () => {
    const out = assembleMarkdownFile({}, 'just text', { bom: true });
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe('just text');
  });

  it('emits a BOM when bom: true is passed (with frontmatter)', () => {
    const out = assembleMarkdownFile({ title: 'Foo' }, 'body', { bom: true });
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1, 5)).toBe('---\n');
  });
});
