import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { bodyLines, escapeRuns, withMinimalEscapes } from '../../renderer/lib/editor/minimalEscapes';
import { escapeUnderscoreRuns } from '../../renderer/lib/editor/textEscapes';
import { renderSoftBreaksAsNodes } from '../../renderer/lib/editor/softBreak';

const md = new MarkdownIt({ html: true, linkify: false, breaks: false });

describe('escapeRuns', () => {
  it('groups the escapes of one delimiter run, bare copies between included', () => {
    expect(escapeRuns('a \\*\\* b \\__\\_ c')).toEqual([[2, 4], [9, 12]]);
  });

  it('scans an escaped backslash as one escape, so the character after it is bare', () => {
    expect(escapeRuns('\\\\*')).toEqual([[0]]);
    expect(escapeRuns('\\\\\\*')).toEqual([[0], [2]]);
  });

  it('groups bracket, hash, tilde and backslash escapes too, and no others', () => {
    expect(escapeRuns('\\[\\[Page\\]\\] \\#tag \\~ \\. \\-')).toEqual([[0, 2], [8, 10], [13], [19]]);
  });

  it('starts a new run at another character or a gap', () => {
    expect(escapeRuns('\\*\\_ \\*')).toEqual([[0], [2], [5]]);
  });
});

describe('withMinimalEscapes', () => {
  it.each([
    ['Chapter 1 and 2\\*\\* - kept', 'Chapter 1 and 2** - kept'],
    ['the \\*\\*\\* and', 'the *** and'],
    ['the \\_\\_\\_ and \\_\\_\\_ they', 'the ___ and ___ they'],
    ['5 \\* 3', '5 * 3'],
    ['see \\[\\[Page\\]\\] and \\[TODO\\]', 'see [[Page]] and [TODO]'],
    ['\\#tag and C:\\\\Users', '#tag and C:\\Users'],
  ])('drops what markdown-it does not need: %s', (input, output) => {
    expect(withMinimalEscapes(input, md)).toBe(output);
  });

  it.each([
    ['a pair that would be emphasis', '\\*a\\*', '*a\\*'],
    ['a thematic break', '\\*\\*\\*', '\\*\\*\\*'],
    ['a list marker', '\\* item', '\\* item'],
    ['code', '`\\*`', '`\\*`'],
    ['an autolink, where a backslash is literal', '<https://example.com/x\\_y>', '<https://example.com/x\\_y>'],
    ['brackets that would make a link', '\\[a\\](b)', '[a\\](b)'],
    ['a heading marker', '\\# Title', '\\# Title'],  ])('keeps what markdown-it needs: %s', (_name, input, output) => {
    const out = withMinimalEscapes(input, md);
    expect(out).toBe(output);
    expect(md.render(out)).toBe(md.render(input));
  });

  it('leaves a line the loaded file holds as it is', () => {
    expect(withMinimalEscapes('5 \\* 3\n\nthe \\*\\*\\* and', md, bodyLines('5 \\* 3\r\n'))).toBe('5 \\* 3\n\nthe *** and');
  });
});

describe('escapeUnderscoreRuns', () => {
  it('escapes a whole run once any of it is escaped', () => {
    expect(escapeUnderscoreRuns('the \\__\\_ and')).toBe('the \\_\\_\\_ and');
  });

  it('leaves a bare run and other escapes alone', () => {
    expect(escapeUnderscoreRuns('snake_case a__b \\* \\\\_')).toBe('snake_case a__b \\* \\\\_');
  });
});

describe('renderSoftBreaksAsNodes', () => {
  it('renders a soft break as the node element, and a breaks: true parser keeps its <br>', () => {
    const notes = new MarkdownIt({ html: true, breaks: false });
    const paste = new MarkdownIt({ html: false, breaks: true });
    renderSoftBreaksAsNodes(notes);
    renderSoftBreaksAsNodes(paste);
    expect(notes.render('a\nb')).toBe('<p>a<br data-filo-soft-break>b</p>\n');
    expect(paste.render('a\nb')).toBe('<p>a<br>b</p>\n');
  });
});
