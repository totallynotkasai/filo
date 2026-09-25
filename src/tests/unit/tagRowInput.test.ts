import { describe, it, expect } from 'vitest';
import {
  parseTagInput,
  withTagsAdded,
  tagSuggestions,
  completeLastEntry,
} from '../../renderer/lib/tags/tagRowInput';

/**
 * The tag row's typing rules: comma-separated entries, the vault's casing for
 * a known tag, the Tags browser's check for a new one.
 */
describe('parseTagInput', () => {
  it('splits on commas, drops a leading #, trims and ignores empty entries', () => {
    expect(parseTagInput(' alpha, #beta ,, gamma', [])).toEqual({ tags: ['alpha', 'beta', 'gamma'], invalid: [] });
  });

  it('takes the vault casing of a known tag, so Project and project stay one tag', () => {
    expect(parseTagInput('PROJECT, work', ['Project'])).toEqual({ tags: ['Project', 'work'], invalid: [] });
  });

  it('rejects names with spaces, plain numbers and leading indicator symbols', () => {
    expect(parseTagInput('two words, 123, @home, ok', [])).toEqual({ tags: ['ok'], invalid: ['two words', '123', '@home'] });
  });

  it('accepts a known tag even if it would fail the new-name check', () => {
    expect(parseTagInput('2024', ['2024'])).toEqual({ tags: ['2024'], invalid: [] });
  });

  it('collapses duplicates, ignoring case', () => {
    expect(parseTagInput('a, A, a', [])).toEqual({ tags: ['a'], invalid: [] });
  });
});

describe('withTagsAdded', () => {
  it('appends only tags not already there (ignoring case), keeping order', () => {
    expect(withTagsAdded(['work', 'Home'], ['home', 'new', 'work', 'next'])).toEqual(['work', 'Home', 'new', 'next']);
  });
});

describe('tagSuggestions', () => {
  const known = ['project', 'project/active', 'personal', 'work'];

  it('suggests known tags containing the entry being typed, minus the applied ones', () => {
    expect(tagSuggestions('pro', known, ['project'])).toEqual(['project/active']);
    expect(tagSuggestions('alpha, per', known, [])).toEqual(['personal']);
  });

  it('suggests nothing for an empty entry', () => {
    expect(tagSuggestions('alpha, ', known, [])).toEqual([]);
  });
});

describe('completeLastEntry', () => {
  it('replaces the entry being typed and leaves room for the next', () => {
    expect(completeLastEntry('alpha, pro', 'project')).toBe('alpha, project, ');
    expect(completeLastEntry('pro', 'project')).toBe('project, ');
  });
});
