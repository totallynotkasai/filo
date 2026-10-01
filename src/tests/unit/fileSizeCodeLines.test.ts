/**
 * The `file-sizes` gate counts lines of code: blank and comment-only lines
 * don't count, so explaining a hazard in a comment never pushes a file over
 * the limit, while every line holding code still does.
 */
import { describe, expect, it } from 'vitest';
import { countCodeLines } from '../../../scripts/gates/codeLines.mjs';

const lines = (...l: string[]): string => l.join('\n') + '\n';

describe('countCodeLines: scripts', () => {
  it('a file of only comments and blank lines counts 0', () => {
    const src = lines(
      '// a line comment',
      '',
      '/**',
      ' * JSDoc text',
      ' * @param x what it is',
      ' */',
      '   ',
      '/* one-line block */',
      '\t// indented',
    );
    expect(countCodeLines(src)).toBe(0);
  });

  it('a mixed file counts only its code lines', () => {
    const src = lines(
      "import { a } from './a';",
      '',
      '// why the guard exists',
      'export function f(x: number): number {',
      '  /* inline note */',
      '  return x + a; // trailing comment',
      '}',
    );
    expect(countCodeLines(src)).toBe(4);
  });

  it('a block comment spanning lines is skipped, code on its closing line counts', () => {
    const src = lines('const a = 1;', '/* first', '   second', '   third */', '/* note */ const b = 2;', 'const c = 3; /* opens', '   closes */');
    expect(countCodeLines(src)).toBe(3);
  });

  it('comment markers inside strings, templates and regex literals are code', () => {
    const src = lines(
      "const url = 'http://example.com';",
      'const s = "/* not a comment";',
      'const t = `',
      '// a line of the template, not a comment',
      '  /* nor this */',
      '`;',
      'const re = /[/*]+/g;',
      'const after = 1;',
    );
    expect(countCodeLines(src)).toBe(8);
  });

  it('a comment inside a template expression is a comment, the template around it is code', () => {
    const src = lines('const t = `${f({', '  // why a is 1', '  a: 1,', '})}`;', '// a real comment');
    expect(countCodeLines(src)).toBe(3);
  });

  it('a division is not read as a regex that hides the comment after it', () => {
    const src = lines('const half = total / 2; /* a note', '   that ends here */', 'const next = half / 2;');
    expect(countCodeLines(src)).toBe(2);
  });

  it('CRLF line endings, a BOM and an empty file count the same as LF', () => {
    expect(countCodeLines('\uFEFF// c\r\nconst a = 1;\r\n\r\n/*\r\n x\r\n */\r\n')).toBe(1);
    expect(countCodeLines('')).toBe(0);
  });
});

describe('countCodeLines: Svelte components', () => {
  it('skips markup, script and style comments and counts the rest', () => {
    const src = lines(
      '<script lang="ts">',
      '  // script comment',
      '  /**',
      '   * JSDoc',
      '   */',
      '  let n = $state(0);',
      '</script>',
      '',
      '<!-- one-line markup comment -->',
      '<!--',
      '  a markup comment',
      '  over three lines -->',
      '<button onclick={() => n++}>Don\'t // stop</button>',
      '',
      '<style>',
      '  /* style comment */',
      '  .a {',
      "    background: url('//cdn/x.png');",
      '  }',
      '</style>',
    );
    // <script>, let, </script>, <button>, <style>, .a {, background, }, </style>
    expect(countCodeLines(src, { svelte: true })).toBe(9);
  });

  it('a markup line with code beside a comment counts', () => {
    const src = lines('<div></div> <!-- note -->', '<!-- note --> <span></span>');
    expect(countCodeLines(src, { svelte: true })).toBe(2);
  });
});
