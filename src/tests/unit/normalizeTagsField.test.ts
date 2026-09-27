import { describe, it, expect } from 'vitest';
import {
  normalizeTagsField,
  orderPreservingTagsField,
  parseTagsField,
} from '@renderer/lib/utils/normalizeTagsField';

describe('normalizeTagsField', () => {
  it('returns array form deduped and sorted', () => {
    expect(normalizeTagsField(['b', 'a'])).toEqual(['a', 'b']);
    expect(normalizeTagsField(['dup', 'dup', 'other'])).toEqual(['dup', 'other']);
  });

  it('parses comma-separated string form', () => {
    expect(normalizeTagsField('alpha, beta, gamma')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('splits the string form on commas only, so a tag keeps its spaces', () => {
    expect(normalizeTagsField('Book 1, Planning Project')).toEqual(['Book 1', 'Planning Project']);
    expect(normalizeTagsField('alpha beta gamma')).toEqual(['alpha beta gamma']);
  });

  it('strips a single leading # from each tag', () => {
    expect(normalizeTagsField(['#hash', 'plain'])).toEqual(['hash', 'plain']);
    expect(normalizeTagsField('#a, #b')).toEqual(['a', 'b']);
  });

  it('returns empty for missing / null / non-string-array input', () => {
    expect(normalizeTagsField(undefined)).toEqual([]);
    expect(normalizeTagsField(null)).toEqual([]);
    expect(normalizeTagsField(123)).toEqual([]);
    expect(normalizeTagsField({})).toEqual([]);
  });

  it('filters out empty / hash-only strings inside an array', () => {
    expect(normalizeTagsField(['', 'real', '', '#'])).toEqual(['real']);
  });

  it('returns empty for empty / whitespace-only string', () => {
    expect(normalizeTagsField('')).toEqual([]);
    expect(normalizeTagsField('   ')).toEqual([]);
  });
});

describe('orderPreservingTagsField', () => {
  it('keeps the authored first-seen order (does NOT sort)', () => {
    expect(orderPreservingTagsField(['b', 'a'])).toEqual(['b', 'a']);
    expect(orderPreservingTagsField('gamma, alpha, beta')).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('dedupes by exact string, keeping the first occurrence', () => {
    expect(orderPreservingTagsField(['dup', 'other', 'dup'])).toEqual(['dup', 'other']);
  });

  it('strips a single leading # and drops empty / hash-only entries', () => {
    expect(orderPreservingTagsField(['#hash', 'plain'])).toEqual(['hash', 'plain']);
    expect(orderPreservingTagsField(['', 'real', '', '#'])).toEqual(['real']);
  });

  it('returns empty for missing / null / junk input', () => {
    expect(orderPreservingTagsField(undefined)).toEqual([]);
    expect(orderPreservingTagsField(null)).toEqual([]);
    expect(orderPreservingTagsField(123)).toEqual([]);
  });

  it('yields the same SET as normalizeTagsField — only the order differs', () => {
    for (const input of [['b', 'a', '#c', 'a'], 'zoo, apple, mango', ['#x', 'y', 'x']]) {
      expect([...orderPreservingTagsField(input)].sort()).toEqual(normalizeTagsField(input));
    }
  });
});

describe('parseTagsField', () => {
  it('flags array form with wasString=false', () => {
    const r = parseTagsField(['foo', 'bar']);
    expect(r).toEqual({ tags: ['foo', 'bar'], wasString: false, recognised: true });
  });

  it('flags string form with wasString=true', () => {
    const r = parseTagsField('foo, bar');
    expect(r).toEqual({ tags: ['foo', 'bar'], wasString: true, recognised: true });
  });

  it('preserves a leading # so callers can round-trip the source form', () => {
    expect(parseTagsField(['#a', 'b']).tags).toEqual(['#a', 'b']);
    expect(parseTagsField('#a, #b').tags).toEqual(['#a', '#b']);
  });

  it('drops non-string elements from an array silently', () => {
    expect(parseTagsField(['a', 42 as unknown as string, null as unknown as string]).tags).toEqual([
      'a',
    ]);
  });

  it('reports recognised=false for non-string / non-array input', () => {
    expect(parseTagsField(null).recognised).toBe(false);
    expect(parseTagsField(undefined).recognised).toBe(false);
    expect(parseTagsField(123).recognised).toBe(false);
    expect(parseTagsField({}).recognised).toBe(false);
  });

  it('reports recognised=true even when the string is empty (legacy YAML form is still recognised)', () => {
    const r = parseTagsField('');
    expect(r.recognised).toBe(true);
    expect(r.wasString).toBe(true);
    expect(r.tags).toEqual([]);
  });
});
