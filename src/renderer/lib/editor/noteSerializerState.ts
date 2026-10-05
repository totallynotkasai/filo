import { MarkdownSerializerState } from 'prosemirror-markdown';
import type { MarkdownSerializer } from 'prosemirror-markdown';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * prosemirror-markdown's serializer state, made linear for long notes.
 *
 * At every block the state asks whether its output ends a line, with a
 * regular expression over the whole output, and the writes in between leave
 * that output a fresh string each time, so every question copied all of it:
 * a save took 4 ms at 10,000 words, 75 ms at 40,000 and close to a second at
 * 100,000, after every typing pause. Here every write goes through `append`,
 * which keeps the output's last two characters at hand, and the questions
 * read those. The writing rules are prosemirror-markdown's own, unchanged.
 *
 * Something that writes `out` directly (`state.out += …`) is noticed by the
 * output's length, and the next question reads the output itself once.
 */

type NodeSpecs = ConstructorParameters<typeof MarkdownSerializer>[0];
type MarkSpecs = ConstructorParameters<typeof MarkdownSerializer>[1];

/** The state's parts prosemirror-markdown's typings leave out (marked internal there). */
interface StateInternals {
  out: string;
  delim: string;
  closed: ProseMirrorNode | null;
  atBlockStart: boolean;
  atBlank(): boolean;
  flushClose(size?: number): void;
}

type StateConstructor = new (
  nodes: NodeSpecs,
  marks: MarkSpecs,
  options: { hardBreakNodeName?: string },
) => MarkdownSerializerState & StateInternals;

const BaseState = MarkdownSerializerState as unknown as StateConstructor; // allow-cast: prosemirror-markdown's typings leave out the state's constructor and the internals it is built on

export class NoteSerializerState extends BaseState {
  /** The output's last two characters, and the output's length they were taken at. */
  private tail = '';
  private tailAt = 0;

  /** Where a line of text ends in the output, for `withoutLineEndSpaces`. */
  readonly lineEnds: number[] = [];

  /**
   * Notes that a line of text ends here: before a soft break's newline, or at
   * the end of a paragraph, heading or table cell. Markdown drops spaces
   * there, or reads two before a newline as a hard break.
   */
  markLineEnd(): void {
    this.lineEnds.push(this.out.length);
  }

  /** The output's last two characters (fewer when it is shorter). */
  private lastChars(): string {
    if (this.tailAt !== this.out.length) {
      // Written to directly: read the output once.
      this.tail = this.out.slice(-2);
      this.tailAt = this.out.length;
    }
    return this.tail;
  }

  /** Adds `text` to the output. */
  append(text: string): void {
    if (!text) return;
    const before = text.length >= 2 ? '' : this.lastChars();
    this.out += text;
    this.tail = (before + text).slice(-2);
    this.tailAt = this.out.length;
  }

  atBlank(): boolean {
    return this.out.length === 0 || this.lastChars().endsWith('\n');
  }

  ensureNewLine(): void {
    if (!this.atBlank()) this.append('\n');
  }

  write(content?: string): void {
    this.flushClose();
    if (this.delim && this.atBlank()) this.append(this.delim);
    if (content) this.append(content);
  }

  flushClose(size = 2): void {
    if (!this.closed) return;
    if (!this.atBlank()) this.append('\n');
    if (size > 1) {
      const delimMin = this.delim.replace(/\s+$/, '');
      for (let i = 1; i < size; i++) this.append(`${delimMin}\n`);
    }
    this.closed = null;
  }

  text(text: string, escape = true): void {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      this.write();
      const line = lines[i] ?? '';
      // An exclamation mark right before a link would make it an image.
      const tail = this.lastChars();
      if (!escape && line[0] === '[' && tail.endsWith('!') && (tail.length === 1 || tail[0] !== '\\')) {
        this.out = `${this.out.slice(0, -1)}\\!`;
      }
      this.append(escape ? this.esc(line, this.atBlockStart) : line);
      if (i !== lines.length - 1) this.append('\n');
    }
  }
}

/** A note as written: the Markdown, and where its lines of text end (`markLineEnd`). */
export interface NoteMarkdown {
  text: string;
  lineEnds: readonly number[];
}

/** `content` as Markdown, written with `nodes` and `marks` by a `NoteSerializerState`. */
export function serializeNote(
  content: ProseMirrorNode,
  nodes: NodeSpecs,
  marks: MarkSpecs,
  options: { hardBreakNodeName?: string },
): NoteMarkdown {
  const state = new NoteSerializerState(nodes, marks, options);
  state.renderContent(content);
  return { text: state.out, lineEnds: state.lineEnds };
}
