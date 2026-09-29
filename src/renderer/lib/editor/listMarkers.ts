import { BulletList } from '@tiptap/extension-bullet-list';
import { OrderedList } from '@tiptap/extension-ordered-list';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * How lists are marked in the file, so each list reads back as the list it is.
 *
 * Markdown joins list items separated only by blank lines into one list, and
 * reads a bullet list and a checklist written with the same bullet as one
 * mixed list (which the editor can't hold: it reloaded with a filler
 * checkbox, and the note opened read-only). Converting one bullet of a list
 * to a checklist item (Ctrl+Shift+9) leaves exactly that shape, and pressing
 * Enter twice in a numbered list leaves two numbered lists with a blank line
 * between. CommonMark starts a new list when the bullet character or the
 * number's delimiter changes, so a list written right after another list of
 * its family takes the other one: `-` then `*` for bullets and checklists,
 * `1.` then `1)` for numbered lists. Every other list keeps `-` / `1.`, so
 * notes without adjacent lists are written as before.
 *
 * A tight list (no blank lines between items) can hold a nested list right
 * under an item's text, but any other block there (a table, code, a quote)
 * is written after a blank line, which makes the list loose when it is read
 * back. Such a list is written loose, which is how it reads back.
 */

const BULLET_KINDS = new Set(['bulletList', 'taskList']);
const ORDERED_KINDS = new Set(['orderedList']);
const LIST_KINDS = new Set(['bulletList', 'taskList', 'orderedList']);

/** Nothing but blank lines is written for these, so lists on either side still touch in the file. */
function writesNothing(node: ProseMirrorNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

/** How many lists of `kinds` run straight before `index` in `parent`. */
function adjacentRun(parent: ProseMirrorNode | null | undefined, index: number, kinds: ReadonlySet<string>): number {
  if (!parent) return 0;
  let run = 0;
  for (let i = index - 1; i >= 0; i--) {
    const prev = parent.child(i);
    if (writesNothing(prev)) continue;
    if (!kinds.has(prev.type.name)) break;
    run++;
  }
  return run;
}

/** `-` or `*` for the bullet or task list at `index` in `parent`. */
export function listMarkerFor(parent: ProseMirrorNode | null | undefined, index: number): '-' | '*' {
  return adjacentRun(parent, index, BULLET_KINDS) % 2 === 0 ? '-' : '*';
}

/** `.` or `)` for the numbered list at `index` in `parent`. */
export function orderedDelimiterFor(parent: ProseMirrorNode | null | undefined, index: number): '.' | ')' {
  return adjacentRun(parent, index, ORDERED_KINDS) % 2 === 0 ? '.' : ')';
}

/** `list`, marked loose when a tight list couldn't be read back tight. */
export function asWritten(list: ProseMirrorNode): ProseMirrorNode {
  if (list.attrs.tight === false) return list;
  let holdsBlock = false;
  list.forEach((item) => {
    item.forEach((child, _offset, i) => {
      if (i > 0 && !LIST_KINDS.has(child.type.name)) holdsBlock = true;
    });
  });
  return holdsBlock ? list.type.create({ ...list.attrs, tight: false }, list.content, list.marks) : list;
}

/** The slice of prosemirror-markdown's serializer state a list needs. */
export interface ListSerializeState {
  inTightList: boolean;
  renderList(node: ProseMirrorNode, delim: string, firstDelim: (index: number) => string): void;
  repeat(str: string, n: number): string;
}

/**
 * `list` with an empty first item given a lead space, when the list sits
 * straight under a line of text in a tight list item. There an empty item
 * (`-`, `1.`) can't start a list: `-` under a line of text makes that line a
 * heading, and `1.` joins the line. Written `- &#32;` it is an item with text.
 */
function withFirstItemThatStartsAList(
  state: ListSerializeState,
  list: ProseMirrorNode,
  parent: ProseMirrorNode,
  index: number,
): ProseMirrorNode {
  if (!state.inTightList || index === 0 || !parent.child(index - 1).isTextblock) return list;
  const item = list.firstChild;
  const text = item?.firstChild;
  const leadSpace = list.type.schema.nodes.leadSpace;
  // A checklist item always has text in the file (`[ ] `).
  if (!item || item.type.name === 'taskItem' || !text || text.type.name !== 'paragraph' || text.content.size > 0 || !leadSpace) return list;
  const filled = item.copy(item.content.replaceChild(0, text.copy(Fragment.from(leadSpace.create()))));
  return list.copy(list.content.replaceChild(0, filled));
}

/** Writes a bullet or task list with the bullet `listMarkerFor` picks. */
export function serializeBulletList(
  state: ListSerializeState,
  node: ProseMirrorNode,
  parent: ProseMirrorNode,
  index: number,
): void {
  const marker = listMarkerFor(parent, index);
  state.renderList(asWritten(withFirstItemThatStartsAList(state, node, parent, index)), '  ', () => `${marker} `);
}

/** Writes a numbered list as tiptap-markdown does, with the delimiter `orderedDelimiterFor` picks. */
export function serializeOrderedList(
  state: ListSerializeState,
  node: ProseMirrorNode,
  parent: ProseMirrorNode,
  index: number,
): void {
  const start = Number(node.attrs.start) || 1;
  const maxW = String(start + node.childCount - 1).length;
  const space = state.repeat(' ', maxW + 2);
  const separator = `${orderedDelimiterFor(parent, index)} `;
  state.renderList(asWritten(withFirstItemThatStartsAList(state, node, parent, index)), space, (i) => {
    const n = String(start + i);
    return state.repeat(' ', maxW - n.length) + n + separator;
  });
}

/** Bullet list written with `serializeBulletList`. */
export const FiloBulletList = BulletList.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: serializeBulletList,
        parse: {},
      },
    };
  },
});

/** Numbered list written with `serializeOrderedList`. */
export const FiloOrderedList = OrderedList.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: serializeOrderedList,
        parse: {},
      },
    };
  },
});
