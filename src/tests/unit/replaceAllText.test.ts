import { describe, it, expect } from 'vitest';
import { replaceAllConfirmBody, searchedText, type ReplaceAllPreview } from '@renderer/lib/search/replaceAllText';
import { buildNeedleRegex, replaceableMatches, type SearchMatch } from '@renderer/lib/search/runSearch';
import { parseQuery } from '@renderer/lib/search/queryParser';

const NBSP = String.fromCharCode(0xa0);

function confirmBody(count: number, files: string[], titleMatches: number, inSyntax?: number, more: Partial<ReplaceAllPreview> = {}): string {
  return replaceAllConfirmBody({ find: '"dragon"', replace: 'wyvern', count, files, titleMatches, inSyntax, ...more });
}

/**
 * Replace All says what it will change before it runs: the search and the
 * replacement, only body matches (titles are left alone), in which notes,
 * naming at most five.
 */
describe('Replace All confirm', () => {
  it('counts body matches only and names up to five notes', () => {
    const body = confirmBody(9, ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md'], 2);
    expect(body).toMatch(/^Replace "dragon" with "wyvern" \(9 matches in 7 notes\)\?/);
    expect(body).toContain('• e.md');
    expect(body).not.toContain('f.md');
    expect(body).toContain('…and 2 more');
    expect(body).toContain("2 matches in a title aren't replaced");
  });

  it('a single match in one note', () => {
    expect(confirmBody(1, ['a.md'], 0)).toMatch(/^Replace "dragon" with "wyvern" \(1 match in 1 note\)\?\n\n• a\.md\n\nYou can undo/);
  });

  it('names the search and the replacement with every space visible', () => {
    const body = confirmBody(12, ['a.md'], 0, 0, { find: searchedText(parseQuery(' - ')), replace: ' – ' });
    // No-break spaces: the dialog would collapse ordinary ones.
    expect(body).toMatch(new RegExp(`^Replace "${NBSP}-${NBSP}" with "${NBSP}–${NBSP}" \\(12 matches in 1 note\\)\\?`));
  });

  it('text of only spaces says how many, and an empty replacement reads "nothing"', () => {
    const body = confirmBody(3, ['a.md'], 0, 0, { find: searchedText(parseQuery('  ')), replace: '' });
    expect(body).toMatch(new RegExp(`^Replace "${NBSP}${NBSP}" \\(2 spaces\\) with nothing \\(3 matches in 1 note\\)\\?`));
    expect(confirmBody(3, ['a.md'], 0, 0, { replace: ' ' })).toMatch(new RegExp(`with "${NBSP}" \\(1 space\\) \\(3 matches`));
  });

  it('a /regex/ is named as typed', () => {
    expect(searchedText(parseQuery(' /drag(on)?/i '))).toBe('/drag(on)?/i');
    expect(searchedText(parseQuery('tag:x  dragon  fire'))).toBe(`"dragon${NBSP}fire"`);
  });

  it('replaceableMatches skips title matches and lists each note once', () => {
    const m = (filePath: string, matchKind: 'body' | 'title'): SearchMatch => ({ filePath, matchKind } as SearchMatch);
    expect(replaceableMatches([m('a.md', 'body'), m('a.md', 'title'), m('A.md', 'body'), m('b.md', 'body')]))
      .toEqual({ count: 3, files: ['a.md', 'b.md'], inSyntax: 0 });
  });

  it('counts body matches in Markdown syntax apart, and the confirm says they are left alone', () => {
    const m = (filePath: string, inSyntax: boolean): SearchMatch => ({ filePath, matchKind: 'body', inSyntax } as SearchMatch);
    expect(replaceableMatches([m('a.md', true), m('b.md', false), m('c.md', true)]))
      .toEqual({ count: 1, files: ['b.md'], inSyntax: 2 });
    expect(confirmBody(1, ['b.md'], 0, 2))
      .toContain('2 matches inside Markdown formatting (list markers, rules, table lines, link addresses and HTML tags) are left alone.');
    expect(confirmBody(1, ['b.md'], 0, 1)).toContain('1 match inside Markdown formatting');
    expect(confirmBody(1, ['b.md'], 0)).not.toContain('Markdown formatting');
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

  it('Whole word checks no end where the needle itself is a space', () => {
    expect(all(buildNeedleRegex(' - ', { wholeWord: true }), 'well-known a - b')).toEqual(['12: - ']);
    expect(all(buildNeedleRegex(' cat', { wholeWord: true }), 'a cat a catalogue')).toEqual(['1: cat']);
    expect(all(buildNeedleRegex('-', { wholeWord: true }), 'well-known a - b')).toEqual(['13:-']);
  });
});
