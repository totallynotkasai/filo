import MarkdownIt from 'markdown-it';

/**
 * The Task List notes box shows a note's Markdown body as plain text, one
 * line per line. In Markdown a single newline inside a paragraph is only a
 * space, so two lines typed in the box reopened in the rich editor as one
 * line; the note then no longer matched its file and opened read-only (and a
 * rich view already open joined the lines on its next save).
 *
 * DECISION: a newline typed in the box is a line break (not a new paragraph).
 * Before a draft is written, every line that continues a paragraph onto the
 * next line gets Markdown's line-break mark (`\` at its end), which is what
 * the rich editor writes for Shift+Enter. When the box opens, those marks
 * are taken off again for display. Only paragraph lines change: lists,
 * headings, code, quotes' own markers and blank lines are written as typed.
 */

/** Configured like the editor's parser (`createEditor.ts`), for the block structure only. */
const md = new MarkdownIt({ html: true, linkify: false, breaks: false });

/** Each paragraph's source lines, `[first, end)`. */
function paragraphLines(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const token of md.parse(src, {})) {
    if (token.type === 'paragraph_open' && token.map) ranges.push([token.map[0], token.map[1]]);
  }
  return ranges;
}

/** A line already ending in a line break: an odd run of `\`, or two or more spaces. */
function endsInBreak(line: string): boolean {
  const body = line.replace(/\r$/, '');
  return /(^|[^\\])(\\\\)*\\$/.test(body) || / {2,}$/.test(body);
}

/** The draft as the note's body: each newline inside a paragraph becomes a line break. */
export function boxTextToBody(text: string): string {
  const lines = text.split('\n');
  for (const [first, end] of paragraphLines(text)) {
    for (let i = first; i < end - 1; i++) {
      const line = lines[i] ?? '';
      if (!endsInBreak(line)) lines[i] = `${line.replace(/[ \t]+$/, '')}\\`;
    }
  }
  return lines.join('\n');
}

/** The note's body as the box shows it: line breaks inside a paragraph as plain newlines. */
export function bodyToBoxText(body: string): string {
  const lines = body.split('\n');
  for (const [first, end] of paragraphLines(body)) {
    for (let i = first; i < end - 1; i++) {
      const line = lines[i] ?? '';
      if (!endsInBreak(line)) continue;
      lines[i] = line.replace(/(?:\\| {2,})(\r?)$/, '$1');
    }
  }
  return lines.join('\n');
}
