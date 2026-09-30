/**
 * Asterisks and underscores in a note's text are written without a backslash
 * wherever the backslash changes nothing.
 *
 * prosemirror-markdown escapes every `*` and `_` in text (an `_` inside a word
 * excepted), so a literal `2** - notes` or a `the ___ and` placeholder was
 * saved as `2\*\* - notes` and `the \__\_ and`. Both read back the same, but
 * a note written elsewhere with the bare characters no longer matched its file
 * and opened read-only.
 *
 * After the whole note is serialised, each run of escaped `*` or `_` is tried
 * without its backslashes. A change is kept only when markdown-it, the parser
 * the note is loaded with, renders the whole note to the same HTML as before:
 * then the note loads as the same document, so the output is still a fixed
 * point. Any other escape (in code, in a link, one that would open emphasis,
 * a list or a rule) stays.
 *
 * A line the loaded file already holds, escapes and all, is left as it is:
 * another app (or the user) may have written `5 \* 3` on purpose, and a note
 * that saved byte for byte before must still do so.
 */

/** The slice of markdown-it this pass renders with. */
export interface MarkdownRenderer {
  render(src: string, env?: object): string;
}

/** A run of escapes of one delimiter character: the indexes of their backslashes. */
type EscapeRun = number[];

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Most renders one note spends on this; past it, the remaining escapes stay. */
const RENDER_BUDGET = 48;

/** Each run of `\*` or `\_` escapes in `text`, a backslash that is itself escaped skipped. */
export function escapeRuns(text: string): EscapeRun[] {
  const runs: EscapeRun[] = [];
  let run: EscapeRun = [];
  let runChar = '';
  let runEnd = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') continue;
    const next = text[i + 1] ?? '';
    if (!ASCII_PUNCTUATION.test(next)) continue;
    if (next === '*' || next === '_') {
      // One run while only bare copies of the same character sit between.
      const gap = runEnd >= 0 ? text.slice(runEnd, i) : '';
      if (run.length > 0 && next === runChar && [...gap].every((c) => c === runChar)) {
        run.push(i);
      } else {
        if (run.length > 0) runs.push(run);
        run = [i];
        runChar = next;
      }
      runEnd = i + 2;
    }
    i++;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

function without(text: string, backslashes: ReadonlySet<number>): string {
  let out = '';
  for (let i = 0; i < text.length; i++) if (!backslashes.has(i)) out += text[i];
  return out;
}

/** The line of `text` that holds `index`. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? text.length : end);
}

/** A body's lines as `withMinimalEscapes` compares them (no line endings). */
export function bodyLines(body: string): Set<string> {
  return new Set(body.split(/\r?\n|\r/));
}

/**
 * `markdown` with every `*` / `_` escape markdown-it doesn't need taken out,
 * except on a line `keepLines` (the loaded file's lines) holds as it is.
 */
export function withMinimalEscapes(markdown: string, md: MarkdownRenderer, keepLines?: ReadonlySet<string>): string {
  const runs = escapeRuns(markdown).filter((run) => !keepLines?.has(lineAt(markdown, run[0] ?? 0)));
  if (runs.length === 0) return markdown;
  let renders = 0;
  const render = (src: string): string => {
    renders++;
    return md.render(src, {});
  };
  const target = render(markdown);
  const dropped = new Set<number>();
  // Try a span of runs at once; split it when it changes the note.
  const tryRuns = (from: number, to: number): void => {
    if (from >= to || renders >= RENDER_BUDGET) return;
    const candidate = new Set(dropped);
    for (let r = from; r < to; r++) for (const i of runs[r] ?? []) candidate.add(i);
    if (render(without(markdown, candidate)) === target) {
      for (const i of candidate) dropped.add(i);
      return;
    }
    if (to - from === 1) return;
    const mid = Math.floor((from + to) / 2);
    tryRuns(from, mid);
    tryRuns(mid, to);
  };
  tryRuns(0, runs.length);
  return dropped.size === 0 ? markdown : without(markdown, dropped);
}
