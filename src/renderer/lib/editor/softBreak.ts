import { Node } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';

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

/**
 * `block` as it is saved: a soft break keeps only the marks the text after it
 * also has. Written inside a run the next line doesn't continue, the closing
 * delimiter would open the next line (`**a\n**b`), where Markdown can't read
 * it as closing. prosemirror-markdown does the same for a hard break.
 * Returns `block` itself when nothing changes.
 */
export function withSoftBreakMarksTrimmed(block: ProseMirrorNode): ProseMirrorNode {
  const children: ProseMirrorNode[] = [];
  let changed = false;
  block.forEach((child, _offset, index) => {
    if (child.type.name !== 'softBreak' || child.marks.length === 0) {
      children.push(child);
      return;
    }
    const next = block.maybeChild(index + 1);
    const keep = next && (!next.isText || /\S/.test(next.text ?? ''))
      ? child.marks.filter((m) => m.isInSet(next.marks))
      : [];
    if (keep.length === child.marks.length) {
      children.push(child);
      return;
    }
    children.push(child.mark(keep));
    changed = true;
  });
  return changed ? block.copy(Fragment.fromArray(children)) : block;
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
 * parser with `breaks: true` (the plain-text paste) keeps its hard `<br>`.
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
