import { describe, it, expect } from 'vitest';
import { replaceAllConfirmBody } from '@renderer/lib/search/replaceAllText';
import { buildNeedleRegex, replaceableMatches, type SearchMatch } from '@renderer/lib/search/runSearch';

/**
 * Replace All says what it will change before it runs: only body matches
 * (titles are left alone), in which notes, naming at most five.
 */
describe('Replace All confirm', () => {
  it('counts body matches only and names up to five notes', () => {
    const body = replaceAllConfirmBody(9, ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md'], 2);
    expect(body).toMatch(/^Replace 9 matches in 7 notes\?/);
    expect(body).toContain('• e.md');
    expect(body).not.toContain('f.md');
    expect(body).toContain('…and 2 more');
    expect(body).toContain("2 matches in a title aren't replaced");
  });

  it('a single match in one note', () => {
    expect(replaceAllConfirmBody(1, ['a.md'], 0)).toMatch(/^Replace 1 match in 1 note\?\n\n• a\.md\n\nYou can undo/);
  });

  it('replaceableMatches skips title matches and lists each note once', () => {
    const m = (filePath: string, matchKind: 'body' | 'title'): SearchMatch => ({ filePath, matchKind } as SearchMatch);
    expect(replaceableMatches([m('a.md', 'body'), m('a.md', 'title'), m('A.md', 'body'), m('b.md', 'body')]))
      .toEqual({ count: 3, files: ['a.md', 'b.md'] });
  });
});

describe('buildNeedleRegex', () => {
  const all = (re: RegExp | null, text: string): string[] => [...text.matchAll(re!)].map((x) => `${x.index}:${x[0]}`);

  it('is a case-insensitive substring by default', () => {
    expect(all(buildNeedleRegex('cat'), 'Cat concatenate')).toEqual(['0:Cat', '7:cat']);
  });

  it('Match case keeps the case', () => {
    expect(all(buildNeedleRegex('cat', { matchCase: true }), 'Cat concatenate')).toEqual(['7:cat']);
  });

  it('Whole word needs no letter, digit or _ at either end, in any script', () => {
    const re = buildNeedleRegex('café', { wholeWord: true });
    expect(all(re, 'café cafés écafé (café) café_1 café.')).toEqual(['0:café', '18:café', '31:café']);
  });

  it('treats metacharacters literally', () => {
    expect(all(buildNeedleRegex('a.b(c)', { wholeWord: true }), 'a.b(c) axb(c)')).toEqual(['0:a.b(c)']);
  });
});
