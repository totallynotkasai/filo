import { Node } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Spaces typed at the start of a line are kept.
 *
 * Markdown drops up to three spaces at the start of a line, and four or more
 * make the line a code block, so a paragraph typed with a leading indent
 * reopened changed (and read-only). Where a line would start with a space
 * (the start of a paragraph, heading, list item or table cell, or right after
 * a line break), the first space is written as the entity `&#32;`, so the
 * line no longer starts with whitespace. One is enough.
 *
 * markdown-it reads the entity back as a space, but the load's whitespace
 * tidy (`keepSpaces.ts`) can't tell it from indentation, and ProseMirror drops
 * a space that opens a list item's text. So the `filo-lead-space` rule turns
 * the entity into `<span data-filo-space>`, which loads as this node: one
 * space, written back as `&#32;` at the start of a line and as a plain space
 * anywhere else. It mirrors the tab (`tabNode.ts`).
 *
 * Spaces at the end of a line are not kept: Markdown drops them, they show
 * nothing, and the round-trip check ignores them.
 */

export const LEAD_SPACE_ENTITY = '&#32;';

/** True when the inline child at `index` starts a line of its block. */
export function startsLine(parent: ProseMirrorNode | null | undefined, index: number): boolean {
  if (!parent || index === 0) return true;
  return parent.child(index - 1).type.name === 'hardBreak';
}

/** Marks written as Markdown delimiter runs, which push whitespace outside the run. */
const DELIMITER_MARKS = new Set(['bold', 'italic', 'strike']);

/**
 * `block` as it is saved: a line that starts with a space inside a bold,
 * italic or strikethrough run has that space taken out of the run, so it is
 * written as `&#32;` before the delimiter (inside it, the serialiser would
 * move the space outside the run as plain text, where Markdown drops it).
 * Returns `block` itself when nothing changes.
 */
export function withLeadSpacesOutsideRuns(block: ProseMirrorNode): ProseMirrorNode {
  const children: ProseMirrorNode[] = [];
  let changed = false;
  block.forEach((child, _offset, index) => {
    const text = child.text ?? '';
    const delimited = child.marks.some((m) => DELIMITER_MARKS.has(m.type.name));
    if (child.isText && text.startsWith(' ') && delimited && startsLine(block, index)) {
      children.push(block.type.schema.text(' ', child.marks.filter((m) => !DELIMITER_MARKS.has(m.type.name))));
      if (text.length > 1) children.push(child.cut(1));
      changed = true;
    } else {
      children.push(child);
    }
  });
  return changed ? block.copy(Fragment.fromArray(children)) : block;
}

/**
 * `node` with each line-start space in its text as a lead-space node, for a
 * block written as HTML (a table Markdown can't hold, an aligned paragraph):
 * there the load's whitespace tidy would drop a plain leading space, but the
 * node's `<span data-filo-space>` reads back. Returns `node` itself when
 * nothing changes.
 */
export function withLeadSpaceNodes(node: ProseMirrorNode): ProseMirrorNode {
  const leadSpace = node.type.schema.nodes.leadSpace;
  if (!leadSpace) return node;
  if (node.isTextblock) {
    const children: ProseMirrorNode[] = [];
    let changed = false;
    node.forEach((child, _offset, index) => {
      if (child.isText && (child.text ?? '').startsWith(' ') && startsLine(node, index)) {
        children.push(leadSpace.create(null, null, child.marks));
        if ((child.text ?? '').length > 1) children.push(child.cut(1));
        changed = true;
      } else {
        children.push(child);
      }
    });
    return changed ? node.copy(Fragment.fromArray(children)) : node;
  }
  if (node.isLeaf) return node;
  const children: ProseMirrorNode[] = [];
  let changed = false;
  node.forEach((child) => {
    const next = withLeadSpaceNodes(child);
    if (next !== child) changed = true;
    children.push(next);
  });
  return changed ? node.copy(Fragment.fromArray(children)) : node;
}

/** The slice of a markdown-it inline token the rule reads. */
interface InlineToken {
  type: string;
  content: string;
  markup: string;
  children: InlineToken[] | null;
}

/** The slice of markdown-it the rule is registered on. */
interface CoreRulerHost {
  core: {
    ruler: {
      before(beforeName: string, ruleName: string, fn: (state: { tokens: InlineToken[] }) => void): void;
    };
  };
}

/** Every `&#32;` in the note, as the span this node loads from. */
export function leadSpaceRule(state: { tokens: InlineToken[] }): void {
  for (const token of state.tokens) {
    for (const child of token.children ?? []) {
      if (child.type === 'text_special' && child.markup === LEAD_SPACE_ENTITY) {
        child.type = 'html_inline';
        child.content = '<span data-filo-space> </span>';
      }
    }
  }
}

/** Markdown-it instances already given the rule (tiptap-markdown calls `setup` on every parse). */
const prepared = new WeakSet<object>();

interface LeadSpaceSerializeState {
  write(content: string): void;
}

export const LeadSpace = Node.create({
  name: 'leadSpace',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'span[data-filo-space]' }];
  },

  renderHTML() {
    return ['span', { 'data-filo-space': '' }, ' '];
  },

  renderText() {
    return ' ';
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: LeadSpaceSerializeState, _node: ProseMirrorNode, parent: ProseMirrorNode, index: number): void {
          state.write(startsLine(parent, index) ? LEAD_SPACE_ENTITY : ' ');
        },
        parse: {
          setup(md: CoreRulerHost): void {
            if (prepared.has(md)) return;
            prepared.add(md);
            // Before `text_join`, which merges the entity into the text around it.
            md.core.ruler.before('text_join', 'filo-lead-space', leadSpaceRule);
          },
        },
      },
    };
  },
});
