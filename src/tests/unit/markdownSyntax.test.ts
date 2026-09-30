import { describe, it, expect } from 'vitest';
import { markdownSyntaxRanges, overlapsSyntax } from '@renderer/lib/search/markdownSyntax';

/** The syntax text in `body`, once per distinct range, in order. */
function syntaxIn(body: string): string[] {
  const distinct = new Map(markdownSyntaxRanges(body).map((r) => [`${r.start}:${r.end}`, r]));
  return [...distinct.values()]
    .sort((a, b) => a.start - b.start)
    .map((r) => body.slice(r.start, r.end));
}

describe('markdownSyntaxRanges', () => {
  it('finds list and number markers opening a line, in a quote too, with a task box', () => {
    expect(syntaxIn('- a\n  * b\n10. c\n2) d\n> - e\n- [x] done\n')).toEqual(['-', '*', '10.', '2)', '-', '- [x]']);
  });

  it('a dash in a sentence, or emphasis opening a line, is not a marker', () => {
    expect(syntaxIn('one - two\n*emphasis* here\n-not a list\n')).toEqual([]);
  });

  it('a rule and a table delimiter row are syntax as whole lines', () => {
    expect(syntaxIn('---\n* * *\n| a | b |\n|---|:-:|\n--- | ---\n')).toEqual(['---', '* * *', '|---|:-:|', '--- | ---']);
  });

  it('link, image and reference destinations, autolinks and HTML tags', () => {
    const body = '[a](x.md "t") ![i](<my pic.png>)\n[r]: https://r.example\n<https://auto.example> <b class="k">bold</b> <!-- c -->';
    expect(syntaxIn(body)).toEqual(['x.md', '<my pic.png>', 'https://r.example', '<https://auto.example>', '<b class="k">', '</b>', '<!-- c -->']);
  });

  it('a destination with balanced parentheses', () => {
    expect(syntaxIn('[w](https://en.wikipedia.org/wiki/Foo_(bar)) after')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  it('CRLF lines', () => {
    expect(syntaxIn('- a\r\n---\r\ntext\r\n')).toEqual(['-', '---']);
  });

  it('overlapsSyntax: touching a range counts, sitting next to it does not', () => {
    const ranges = [{ start: 2, end: 3 }];
    expect(overlapsSyntax(ranges, 1, 4)).toBe(true);
    expect(overlapsSyntax(ranges, 2, 3)).toBe(true);
    expect(overlapsSyntax(ranges, 3, 5)).toBe(false);
    expect(overlapsSyntax(ranges, 0, 2)).toBe(false);
  });
});
