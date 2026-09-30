import { Node } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { LEAD_SPACE_ENTITY, startsLine } from './leadSpace';

/**
 * The editor's text node, with the Markdown escaping a note's text needs.
 *
 * tiptap-markdown escapes `<` and `>` in text, but not `&`. Typed text such
 * as `&amp;` or `&copy;` was then saved as-is, and markdown-it read it back as
 * the character it names (`&`, `©`): the note changed meaning on reopen. An
 * `&` that starts a character reference is written as `&amp;`, which reads
 * back as the `&` that was typed. Any other `&` stays as it is.
 *
 * More escapes depend on where the text sits:
 *  - a line that starts with a space writes that space as `&#32;`
 *    (`leadSpace.ts`);
 *  - text that opens a line and would read as a list marker, heading or
 *    heading underline is escaped (`escapeBlockStart`, `escapeAfterBreak`);
 *  - in a Markdown table a `|` is written `\|`, since a bare one ends the cell.
 */

interface TextSerializeState {
  text(text: string, escape?: boolean): void;
  esc(text: string, startOfLine?: boolean): string;
  atBlockStart: boolean;
  inAutolink?: boolean;
  inTable?: boolean;
}

/** `&` followed by what markdown-it would read as a named or numeric character reference. */
const CHARACTER_REFERENCE = /&(?=(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});)/g;

/** Text as it is written to the file, before prosemirror-markdown's own escaping. */
export function escapeNoteText(text: string, inAutolink = false): string {
  // The reference escape runs first, so the `&` of the `&lt;` added below stays.
  const refsKept = inAutolink ? text : text.replace(CHARACTER_REFERENCE, '&amp;');
  return refsKept.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Text already escaped by prosemirror-markdown, with every underscore of a run
 * escaped once any of them is. prosemirror-markdown leaves an `_` bare between
 * two word characters, and counts `_` as one, so `the ___ and` came out as
 * `the \__\_ and`, and the bare middle one paired with the next such run as
 * emphasis on reopen.
 */
export function escapeUnderscoreRuns(escaped: string): string {
  if (!escaped.includes('_')) return escaped;
  // Each character, with the escaped ones marked (a `\\` pair is not an escape of what follows).
  const chars: Array<{ c: string; escaped: boolean }> = [];
  for (let i = 0; i < escaped.length; i++) {
    const c = escaped[i] ?? '';
    if (c === '\\' && i + 1 < escaped.length) {
      chars.push({ c: escaped[i + 1] ?? '', escaped: true });
      i++;
    } else {
      chars.push({ c, escaped: false });
    }
  }
  let out = '';
  for (let i = 0; i < chars.length; ) {
    let end = i;
    while (chars[end]?.c === '_') end++;
    if (end === i) {
      const ch = chars[i];
      out += ch ? (ch.escaped ? `\\${ch.c}` : ch.c) : '';
      i++;
      continue;
    }
    const run = chars.slice(i, end);
    const escapeAll = run.some((ch) => ch.escaped);
    for (const ch of run) out += escapeAll || ch.escaped ? '\\_' : '_';
    i = end;
  }
  return out;
}

/**
 * A block's first text, already escaped by prosemirror-markdown, with the
 * list markers it misses: a lone `+` or `1.` (with nothing after it on the
 * line, or only a tab) starts an empty list item.
 */
export function escapeBlockStart(escaped: string, aloneOnLine: boolean): string {
  if (!aloneOnLine) return escaped;
  return escaped.replace(/^\+$/, '\\+').replace(/^(\d{1,9})\.$/, '$1\\.');
}

/**
 * The text that opens a line after a line break (Shift+Enter). prosemirror-markdown
 * escapes only at the start of a block, but a line inside a paragraph is
 * read the same way when it could interrupt the paragraph: a heading, a quote,
 * a bullet or `1.` item with text, or (when it is the whole line) a row of
 * `=` or `-` that would make the lines above a heading, or a thematic break.
 * Only those are escaped, so any other line is written as it was.
 */
export function escapeAfterBreak(escaped: string, wholeLine: boolean, tabFollows = false): string {
  // A tab item written right after the text counts as the space a marker needs.
  const probe = tabFollows ? `${escaped}\t` : escaped;
  let out = probe
    .replace(/^(#{1,6})(?=[ \t]|$)/, '\\$1')
    .replace(/^>/, '\\>')
    .replace(/^([-+*])(?=[ \t])/, '\\$1')
    .replace(/^(1)([.)])(?=[ \t])/, '$1\\$2');
  if (tabFollows) out = out.slice(0, -1);
  if (wholeLine && (/^(?:=+|-+)[ \t]*$/.test(out) || /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(out))) {
    out = `\\${out}`;
  }
  return out;
}

export const NoteText = Node.create({
  name: 'text',
  group: 'inline',

  addStorage() {
    return {
      markdown: {
        serialize(state: TextSerializeState, node: ProseMirrorNode, parent: ProseMirrorNode, index: number): void {
          // An autolink's text is its URL, where `&…;` is part of the address.
          const inAutolink = state.inAutolink === true;
          let text = escapeNoteText(node.text ?? '', inAutolink);
          if (inAutolink || text.includes('\n')) {
            state.text(text);
            return;
          }
          let blockStart = index === 0 && state.atBlockStart;
          let afterBreak = index > 0 && startsLine(parent, index) && !state.inTable && parent.type.name !== 'heading';
          if (text.startsWith(' ') && startsLine(parent, index)) {
            state.text(LEAD_SPACE_ENTITY, false);
            // The line no longer starts here, so nothing after the entity
            // needs a line-start escape.
            state.atBlockStart = false;
            blockStart = false;
            afterBreak = false;
            text = text.slice(1);
            if (!text) return;
          }
          let out = escapeUnderscoreRuns(state.esc(text, blockStart));
          if (node.marks.length === 0) {
            const next = parent.maybeChild(index + 1);
            // A soft break is written as a bare newline, so the line ends there
            // (a hard break's `\` stays on the line).
            const endsLine = !next || next.type.name === 'softBreak';
            if (blockStart) out = escapeBlockStart(out, endsLine || next?.type.name === 'tab');
            else if (afterBreak) out = escapeAfterBreak(out, endsLine, next?.type.name === 'tab');
            // A heading's trailing ` #` run is read as its closing sequence and dropped.
            if (endsLine && parent.type.name === 'heading') out = out.replace(/(^|[ \t])(#+)$/, '$1\\$2');
          }
          // A `!` right before a link would make it an image. prosemirror-markdown
          // escapes it too, but not after an escaped backslash (`\\!`).
          const next = parent.maybeChild(index + 1);
          const linkMark = next?.marks.find((m) => m.type.name === 'link');
          if (out.endsWith('!') && linkMark && !linkMark.isInSet(node.marks)) out = `${out.slice(0, -1)}\\!`;
          if (state.inTable) out = out.replace(/\|/g, '\\|');
          state.text(out, false);
        },
        parse: {},
      },
    };
  },
});
