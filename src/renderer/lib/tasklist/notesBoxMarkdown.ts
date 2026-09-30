import MarkdownIt from 'markdown-it';

/**
 * The Task List notes box shows a note's Markdown body as plain text, one
 * line per line.
 *
 * DECISION: a newline typed in the box is written as a plain newline. Inside
 * a paragraph that is a soft line break, which the rich editor shows as a
 * line break and writes back unchanged (`lib/editor/softBreak.ts`), so the
 * note reopens as typed and a note written one line per thought keeps its
 * bytes when a line is added in the box.
 *
 * A line break the note already has (a `\` or two spaces at the end of a
 * paragraph line, as Shift+Enter writes it) shows in the box as a plain
 * newline too, so it is written back as one the next time the box saves.
 * It looks the same in every view.
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

/** The draft as the note's body: written as typed, each newline a plain newline. */
export function boxTextToBody(text: string): string {
  return text;
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
