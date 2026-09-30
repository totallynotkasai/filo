import { Extension, Node } from '@tiptap/core';
import { Fragment, type Mark, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

/**
 * A single newline inside a paragraph (a soft line break), as the file has it.
 *
 * Keep, Canvas and plain typing in other apps write one line per thought with
 * no blank line between, which Markdown reads as one paragraph whose lines are
 * joined by soft breaks. Loaded as a space, those lines were joined on the
 * next save, so such a note opened read-only. Here each one loads as this
 * node: shown as a line break (as Obsidian and Keep show it) and written back
 * as a bare newline, so the note saves byte for byte.
 *
 * Shift+Enter still makes a hard break (`hardBreak.ts`), written as `\`.
 * Where a bare newline can't stand (in a heading or table cell, which are one
 * line each; at the start of a block, or right after another break, where it
 * would leave an empty line and end the paragraph) an edit that puts a soft
 * break there has it written as `<br data-filo-soft-break>`, which loads back
 * as this node.
 */

export const SOFT_BREAK_ATTR = 'data-filo-soft-break';

/** A soft break where a bare newline can't stand; it loads back as the same node. */
const SOFT_BREAK_HTML = `<br ${SOFT_BREAK_ATTR}>`;

/** True for either kind of line break inside a block. */
export function isLineBreak(node: ProseMirrorNode | null | undefined): boolean {
  const name = node?.type.name;
  return name === 'hardBreak' || name === 'softBreak';
}

/** The slice of prosemirror-markdown's serializer state a line break writes to. */
export interface BreakSerializeState {
  inTable?: boolean;
  write(content?: string): void;
}

/**
 * Writes the line break at `index` of `parent`. A soft break is a bare
 * newline where one reads back as the same break, else its HTML form. A hard
 * break is Markdown's `\`, or `<br>` in a heading or table cell. A break with
 * nothing but breaks after it in its block shows nothing and isn't written.
 */
export function writeLineBreak(state: BreakSerializeState, parent: ProseMirrorNode, index: number, soft: boolean): void {
  let textFollows = false;
  for (let i = index + 1; i < parent.childCount; i++) {
    if (!isLineBreak(parent.child(i))) {
      textFollows = true;
      break;
    }
  }
  if (!textFollows) return;
  const oneLine = state.inTable === true || parent.type.name === 'heading';
  if (soft && (oneLine || index === 0 || isLineBreak(parent.child(index - 1)))) {
    state.write(SOFT_BREAK_HTML);
    return;
  }
  if (oneLine) {
    state.write('<br>');
    return;
  }
  state.write(soft ? '\n' : '\\\n');
  // Start the next line now (a quote's `> `, a list's indent). Left to the
  // next write, a bold, italic or strikethrough run opening that line records
  // its start before the prefix, and tiptap-markdown's delimiter tidy then
  // cut the `> ` out.
  state.write();
}

/** True when `node` carries `mark` into a run that goes on across a line break. */
function carries(node: ProseMirrorNode | undefined, mark: Mark): boolean {
  if (!node || !mark.isInSet(node.marks)) return false;
  // Whitespace alone is moved out of the run when it is written.
  return !node.isText || /\S/.test(node.text ?? '');
}

/**
 * `block` as it is saved: a line break (soft or hard) keeps only the marks
 * the text on both sides of it has. A break shows no formatting, but a mark
 * on it decides where a bold, italic or strikethrough run is opened or
 * closed. One the text before the break lacks opened on the break, before the
 * next line's `> ` or inside a heading's `<br>` (`Title<**br>Sub**`), and one
 * the text after lacks closed on the next line (`**a\n**b`); Markdown reads
 * neither. Selecting from the end of a line to the end of the next one puts
 * the mark on the break. Returns `block` itself when nothing changes.
 */
export function withBreakMarksTrimmed(block: ProseMirrorNode): ProseMirrorNode {
  const children: ProseMirrorNode[] = [];
  block.forEach((child) => children.push(child));
  let changed = false;
  // A trimmed break can end the run a break next to it continued.
  for (let again = true; again; ) {
    again = false;
    children.forEach((child, i) => {
      if (!isLineBreak(child) || child.marks.length === 0) return;
      const keep = child.marks.filter((m) => carries(children[i - 1], m) && carries(children[i + 1], m));
      if (keep.length === child.marks.length) return;
      children[i] = child.mark(keep);
      changed = again = true;
    });
  }
  return changed ? block.copy(Fragment.fromArray(children)) : block;
}

/**
 * In `tr`, turns every soft break in the textblocks `from`..`to` touches
 * (code aside) into a hard break. A block made into code keeps a hard break
 * as a new line of code but drops any other inline node, so the lines of a
 * one-line-per-thought paragraph ran together (`onetwo`). Positions don't
 * move: both breaks are one position wide.
 */
export function softBreaksAsHardBreaks(tr: Transaction, from: number, to: number): void {
  const { softBreak, hardBreak } = tr.doc.type.schema.nodes;
  if (!softBreak || !hardBreak) return;
  const found: number[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (!node.type.spec.code) {
      node.forEach((child, offset) => {
        if (child.type === softBreak) found.push(pos + 1 + offset);
      });
    }
    return false;
  });
  for (const pos of found) tr.replaceWith(pos, pos + 1, hardBreak.create());
}

/** markdown-it's render rule, as far as the soft break rule reads it. */
type SoftBreakRule = (tokens: never, idx: never, options: { breaks?: boolean }, env: never, self: never) => string;

/** The slice of a markdown-it renderer the rule is set on. */
interface SoftBreakRendererHost {
  renderer: { rules: { softbreak?: SoftBreakRule } };
}

/** Markdown-it instances already given the rule (tiptap-markdown calls `setup` on every parse). */
const prepared = new WeakSet<object>();

/**
 * Renders markdown-it's soft break as the element this node loads from. A
 * parser with `breaks: true` keeps its hard `<br>`.
 */
export function renderSoftBreaksAsNodes(md: SoftBreakRendererHost): void {
  if (prepared.has(md)) return;
  prepared.add(md);
  md.renderer.rules.softbreak = (_tokens, _idx, options) => (options.breaks ? '<br>' : `<br ${SOFT_BREAK_ATTR}>`);
}

export const SoftBreak = Node.create({
  name: 'softBreak',
  group: 'inline',
  inline: true,
  selectable: false,

  parseHTML() {
    // Above the hard break's plain `br` rule.
    return [{ tag: `br[${SOFT_BREAK_ATTR}]`, priority: 60 }];
  },

  renderHTML() {
    return ['br', { [SOFT_BREAK_ATTR]: '' }];
  },

  renderText() {
    return '\n';
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: BreakSerializeState, _node: ProseMirrorNode, parent: ProseMirrorNode, index: number): void {
          writeLineBreak(state, parent, index, true);
        },
        parse: {
          setup(md: SoftBreakRendererHost): void {
            renderSoftBreaksAsNodes(md);
          },
        },
      },
    };
  },
});

/**
 * Enter beside a soft break splits the paragraph at that break, which goes.
 * Left in, it would open the new paragraph (an empty first line, and a
 * `<br data-filo-soft-break>` in a plain note) or end the old one. High
 * priority, so a list item's or table's Enter doesn't split first; it removes
 * the break and hands the key on, so theirs (or the paragraph split) runs on
 * the text without it.
 */
export const SoftBreakEnter = Extension.create({
  name: 'filoSoftBreakEnter',
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty) return false;
        const { $from } = selection;
        const at = $from.nodeAfter?.type.name === 'softBreak'
          ? $from.pos
          : $from.nodeBefore?.type.name === 'softBreak' ? $from.pos - 1 : null;
        if (at === null) return false;
        editor.view.dispatch(editor.state.tr.delete(at, at + 1));
        return false;
      },
    };
  },
});
