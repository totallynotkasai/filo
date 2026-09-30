/**
 * Asterisks, underscores, brackets and a few other characters in a note's
 * text are written without a backslash wherever the backslash changes nothing.
 *
 * prosemirror-markdown escapes every `*`, `_`, `[`, `]`, `~` and `\` in text
 * (an `_` inside a word excepted), so a literal `2** - notes` or a
 * `the ___ and` placeholder was saved as `2\*\* - notes` and `the \__\_ and`,
 * and a `[[wiki link]]` typed next to as `\[\[wiki link\]\]`. They read back
 * the same in Filo, but a note written elsewhere with the bare characters no
 * longer matched its file, and another app (Obsidian) no longer saw its link.
 *
 * After the whole note is serialised, each run of such escapes is tried
 * without its backslashes. A change is kept only when markdown-it, the parser
 * the note is loaded with, renders the whole note to the same HTML as before:
 * then the note loads as the same document, so the output is still a fixed
 * point. Any other escape (in code, in a link, one that would open emphasis,
 * a link, a list, a heading or a rule) stays.
 *
 * A line the loaded file already holds is written as the file spells it,
 * escapes and all (of any character, not only `*` and `_`): another app (or
 * the user) may have written `5 \* 3` or `[[Page]]` on purpose, and a note
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

/** The characters whose escapes this pass tries to drop. */
const MINIMISED = new Set(['*', '_', '[', ']', '#', '~', '\\']);

/**
 * Each run of escapes of one `MINIMISED` character in `text` (`\*\*`,
 * `\[\[`), scanning an escaped backslash as one escape.
 */
export function escapeRuns(text: string): EscapeRun[] {
  const runs: EscapeRun[] = [];
  let run: EscapeRun = [];
  let runChar = '';
  let runEnd = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') continue;
    const next = text[i + 1] ?? '';
    if (!ASCII_PUNCTUATION.test(next)) continue;
    if (MINIMISED.has(next)) {
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

/** A body's lines, in order, as `withMinimalEscapes` compares them (no line endings). */
export function bodyLines(body: string): string[] {
  return body.split(/\r?\n|\r/);
}

/** `line` with every backslash escape of ASCII punctuation taken out: what it says, however it is escaped. */
function unescaped(line: string): string {
  return line.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * For each line of `lines`, the line of `fileLines` that says the same thing
 * however it is escaped: the next unused one after the last match, else any
 * unused one. Lines that are blank or match nothing are left out.
 */
function fileSpellings(lines: readonly string[], fileLines: readonly string[]): Map<number, string> {
  const byText = new Map<string, number[]>();
  fileLines.forEach((line, i) => {
    if (line.trim() === '') return;
    const key = unescaped(line);
    const list = byText.get(key);
    if (list) list.push(i);
    else byText.set(key, [i]);
  });
  const used = new Set<number>();
  const out = new Map<number, string>();
  let last = -1;
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const candidates = byText.get(unescaped(line));
    if (!candidates) return;
    const pick = candidates.find((c) => c > last && !used.has(c)) ?? candidates.find((c) => !used.has(c));
    if (pick === undefined) return;
    used.add(pick);
    last = pick;
    out.set(i, fileLines[pick] ?? line);
  });
  return out;
}

/**
 * `markdown` as it is saved: each line the loaded file holds (`fileLines`,
 * its lines in order), in whatever spelling of its escapes, is written as the
 * file has it; every other `*` / `_` escape markdown-it doesn't need is taken
 * out. Each step is kept only while markdown-it renders the whole note the
 * same, so the output still loads as the same document.
 *
 * Matching by what a line says, in file order, makes this a fixed point: a
 * note Filo saved is written back byte for byte even where the escape search
 * dropped only some escapes on a line, or dropped one of two identical lines'.
 */
export function withMinimalEscapes(markdown: string, md: MarkdownRenderer, fileLines?: readonly string[]): string {
  const lines = markdown.split('\n');
  const spellings = fileLines ? fileSpellings(lines, fileLines) : new Map<number, string>();
  const swaps = [...spellings].filter(([i, text]) => lines[i] !== text).map(([i]) => i);
  if (swaps.length === 0 && escapeRuns(markdown).length === 0) return markdown;

  let renders = 0;
  const render = (src: string): string => {
    renders++;
    return md.render(src, {});
  };
  const target = render(markdown);

  // Lines written as the file spells them. A span of swaps is tried at once
  // and split when it changes the note.
  const adopted = new Set<number>();
  const withSwaps = (extra: Iterable<number>): string => {
    const next = lines.slice();
    for (const i of adopted) next[i] = spellings.get(i) ?? next[i] ?? '';
    for (const i of extra) next[i] = spellings.get(i) ?? next[i] ?? '';
    return next.join('\n');
  };
  const trySwaps = (from: number, to: number): void => {
    if (from >= to || renders >= RENDER_BUDGET) return;
    const span = swaps.slice(from, to);
    if (render(withSwaps(span)) === target) {
      for (const i of span) adopted.add(i);
      return;
    }
    if (to - from === 1) return;
    const mid = Math.floor((from + to) / 2);
    trySwaps(from, mid);
    trySwaps(mid, to);
  };
  trySwaps(0, swaps.length);
  const base = adopted.size === 0 ? markdown : withSwaps([]);

  // A line in the file's spelling keeps its escapes; the others are tried.
  const settled = new Set<number>([...spellings.keys()].filter((i) => !swaps.includes(i) || adopted.has(i)));
  const lineStarts: number[] = [];
  let at = 0;
  for (const line of base.split('\n')) {
    lineStarts.push(at);
    at += line.length + 1;
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((lineStarts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const runs = escapeRuns(base).filter((run) => !settled.has(lineOf(run[0] ?? 0)));
  const dropped = new Set<number>();
  // Try a span of runs at once; split it when it changes the note.
  const tryRuns = (from: number, to: number): void => {
    if (from >= to || renders >= RENDER_BUDGET) return;
    const candidate = new Set(dropped);
    for (let r = from; r < to; r++) for (const i of runs[r] ?? []) candidate.add(i);
    if (render(without(base, candidate)) === target) {
      for (const i of candidate) dropped.add(i);
      return;
    }
    if (to - from === 1) return;
    const mid = Math.floor((from + to) / 2);
    tryRuns(from, mid);
    tryRuns(mid, to);
  };
  tryRuns(0, runs.length);
  return dropped.size === 0 ? base : without(base, dropped);
}
