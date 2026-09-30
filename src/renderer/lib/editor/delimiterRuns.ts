import MarkdownIt from 'markdown-it';
import { MarkdownSerializer, type MarkdownSerializerState } from 'prosemirror-markdown';
import type { Editor } from '@tiptap/core';
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Bold, italic and strikethrough are written as Markdown only where Markdown
 * reads them back.
 *
 * `**`, `*` and `~~` open or close a run only beside certain characters
 * (CommonMark's flanking rules). A run ending in punctuation right before a
 * letter (`**A)**Answer`), or covering one punctuation mark between letters
 * (`a*,*b`), isn't read as formatting. tiptap-markdown's own tidy shifted
 * such a delimiter until it fitted, which took the formatting off the
 * punctuation; it skipped a run at the very start of a note, and it left one
 * delimiter behind when a run shrank to nothing. Those notes reopened with
 * stray asterisks and no read-only banner.
 *
 * Here each run is written where it is, and once the note is written, a run
 * whose opening delimiter can't open or whose closing one can't close (by
 * markdown-it's own test) is written as HTML instead (`<strong>`, `<em>`,
 * `<s>`), which reads back as the same formatting. Whitespace at a run's
 * edges is still moved outside it (prosemirror-markdown), as before.
 */

type MarkSpecs = ConstructorParameters<typeof MarkdownSerializer>[1];
type NodeSpecs = ConstructorParameters<typeof MarkdownSerializer>[0];

/** The HTML tag each delimiter mark falls back to. */
const HTML_TAG: Readonly<Record<string, string>> = { bold: 'strong', italic: 'em', strike: 's' };

/** A delimiter run as written: where its opening and closing delimiters start in the output. */
interface Run {
  readonly mark: Mark;
  readonly delim: string;
  readonly tag: string;
  open: number;
  close: number;
  html: boolean;
}

/** The Markdown written so far. Public at run time; the typings mark it internal. */
function written(state: MarkdownSerializerState): string {
  return (state as MarkdownSerializerState & { out: string }).out;
}

/** Only used for its delimiter scan, which reads no options. */
const scanner = new MarkdownIt();

/** True when the character at `at` is escaped by an odd run of backslashes. */
function escaped(text: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

/** Where the run of delimiter characters holding `at` starts: Markdown judges the whole run. */
function runStart(text: string, at: number): number {
  const ch = text[at];
  let start = at;
  while (start > 0 && text[start - 1] === ch && !escaped(text, start - 1)) start--;
  return start;
}

interface Scanned {
  can_open: boolean;
  can_close: boolean;
  /** The length of the whole run of delimiter characters. */
  length: number;
}

/** How Markdown judges the run of delimiter characters holding `at`. */
function scan(text: string, at: number): Scanned {
  return new scanner.inline.State(text, scanner, {}, []).scanDelims(runStart(text, at), true);
}

/** True when both ways are open to `scanned`: Markdown then decides by what surrounds it. */
function eitherWay(scanned: Scanned): boolean {
  return scanned.can_open && scanned.can_close;
}

/**
 * True when Markdown reads `run`'s delimiters in `text` as opening and
 * closing it. Each must be able to (the flanking rules), and where one could
 * go either way (between two letters, or two punctuation marks), Markdown's
 * pairing must still land on the run as written:
 * - a run of delimiter characters holding more than this delimiter (one
 *   run's closing and the next one's opening, `**Name:***Aria*`) is paired by
 *   the "rule of three", so it is never trusted;
 * - an opening that could close is read as closing while another run of its
 *   character is open around it;
 * - a pair whose run lengths add up to a multiple of three doesn't pair
 *   (unless both are multiples of three).
 * `enclosing` are the runs still written as Markdown.
 */
function flanks(text: string, run: Run, enclosing: readonly Run[]): boolean {
  const opening = scan(text, run.open);
  const closing = scan(text, run.close);
  if (!opening.can_open || !closing.can_close) return false;
  if ((opening.length > run.delim.length && eitherWay(opening)) || (closing.length > run.delim.length && eitherWay(closing))) return false;
  const marker = run.delim[0];
  if (opening.can_close && enclosing.some((o) => o !== run && o.delim[0] === marker && o.open < run.open && run.open < o.close)) {
    return false;
  }
  if (opening.can_close || closing.can_open) {
    const sum = opening.length + closing.length;
    if (sum % 3 === 0 && (opening.length % 3 !== 0 || closing.length % 3 !== 0)) return false;
  }
  return true;
}

/** Records where each bold, italic and strikethrough run is written, and rewrites the ones that don't read back. */
class DelimiterRuns {
  private readonly done: Run[] = [];
  private readonly pending: Run[] = [];

  /** `marks` with the delimiter marks' strings recorded as they are written. */
  markSpecs(marks: MarkSpecs): MarkSpecs {
    const specs: MarkSpecs = { ...marks };
    for (const [name, tag] of Object.entries(HTML_TAG)) {
      const spec = marks[name];
      if (!spec || typeof spec.open !== 'string' || spec.open !== spec.close) continue;
      const delim = spec.open;
      specs[name] = {
        ...spec,
        open: (state, mark) => this.opened(state, mark, delim, tag),
        close: (state, mark) => this.closed(state, mark, delim),
      };
    }
    return specs;
  }

  private opened(state: MarkdownSerializerState, mark: Mark, delim: string, tag: string): string {
    // Start the line now (a quote's `> `, a list's indent), so the run is
    // recorded where its delimiter lands.
    state.write();
    this.pending.push({ mark, delim, tag, open: written(state).length, close: -1, html: false });
    return delim;
  }

  private closed(state: MarkdownSerializerState, mark: Mark, delim: string): string {
    state.write();
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const run = this.pending[i];
      if (!run?.mark.eq(mark)) continue;
      run.close = written(state).length;
      this.pending.splice(i, 1);
      this.done.push(run);
      break;
    }
    return delim;
  }

  /** `markdown` with every run Markdown wouldn't read back written as HTML. */
  finish(markdown: string): string {
    let text = markdown;
    // Rewriting one run changes its neighbours' surroundings, so check again until none changes.
    for (let changed = true; changed; ) {
      changed = false;
      for (const run of this.done) {
        if (run.html || flanks(text, run, this.done.filter((o) => !o.html))) continue;
        text = this.replaceDelimiter(text, run, run.close, `</${run.tag}>`);
        text = this.replaceDelimiter(text, run, run.open, `<${run.tag}>`);
        run.html = true;
        changed = true;
      }
    }
    return text;
  }

  /** `text` with `run`'s delimiter at `at` replaced by `html`, and every recorded position after it moved. */
  private replaceDelimiter(text: string, run: Run, at: number, html: string): string {
    const delta = html.length - run.delim.length;
    for (const other of this.done) {
      if (other.open > at) other.open += delta;
      if (other.close > at) other.close += delta;
    }
    return text.slice(0, at) + html + text.slice(at + run.delim.length);
  }
}

/** The part of tiptap-markdown's serializer Filo builds on. */
interface TiptapMarkdownSerializer {
  readonly nodes: NodeSpecs;
  readonly marks: MarkSpecs;
  serialize(content: ProseMirrorNode): string;
}

/**
 * Makes `editor`'s Markdown serialiser write delimiter runs as above. The
 * node and mark writers stay tiptap-markdown's (with Filo's extensions);
 * only the serializer state is prosemirror-markdown's own, without
 * tiptap-markdown's tidy.
 */
export function installNoteSerializer(editor: Editor): void {
  const serializer = (editor as { storage?: { markdown?: { serializer?: TiptapMarkdownSerializer } } }).storage?.markdown?.serializer;
  if (!serializer) return;
  serializer.serialize = (content: ProseMirrorNode): string => {
    const runs = new DelimiterRuns();
    const markdown = new MarkdownSerializer(serializer.nodes, runs.markSpecs(serializer.marks), {
      hardBreakNodeName: 'hardBreak',
    }).serialize(content);
    return runs.finish(markdown);
  };
}
