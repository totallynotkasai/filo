import { Extension, type CommandProps } from '@tiptap/core';
import { Fragment, NodeRange, type Node as ProseMirrorNode, type NodeType } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { canJoin, findWrapping } from '@tiptap/pm/transform';

/**
 * The list buttons (and Ctrl+Shift+7 / 8 / 9) as a word processor has them:
 * each list the selection reaches changes kind in place, its items and their
 * levels kept.
 *
 * TipTap's toggle changes a list's kind only between bullets and numbers;
 * to or from a checklist it took the list apart and wrapped the lines again,
 * which demoted and promoted items of a nested list at random (select a
 * character profile's list and click Checklist), and with the caret in an
 * item with sub-items it did nothing. Here every list one of whose own lines
 * the selection touches is rebuilt as the new kind, item by item (a list
 * nested in it changes only when the selection reaches its lines too).
 * Plain paragraphs the selection also covers become items of the new kind.
 * With no list in the selection, or when every list it reaches is already of
 * that kind (the button turns the list off), TipTap's own toggle runs.
 */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    filoListSwitch: {
      /** Makes the lists the selection reaches `kind`, or toggles `kind` as TipTap does (see `listSwitch.ts`). */
      switchList: (kind: ListKind) => ReturnType;
    };
  }
}

export type ListKind = 'bulletList' | 'orderedList' | 'taskList';

const LIST_KINDS: ReadonlySet<string> = new Set<ListKind>(['bulletList', 'orderedList', 'taskList']);

function isList(node: ProseMirrorNode): boolean {
  return LIST_KINDS.has(node.type.name);
}

function isItem(node: ProseMirrorNode): boolean {
  return node.type.name === 'listItem' || node.type.name === 'taskItem';
}

/** What the selection reaches: the lists whose own lines it touches, and the paragraphs it covers outside any list. */
interface Reach {
  /** Start positions of the lists. */
  lists: Set<number>;
  /** Start positions of the paragraphs outside list items. */
  loose: number[];
}

function reachOf(state: EditorState): Reach {
  const { from, to } = state.selection;
  const reach: Reach = { lists: new Set(), loose: [] };
  const note = (pos: number, node: ProseMirrorNode): void => {
    const $in = state.doc.resolve(pos + 1);
    const depth = $in.depth - 1;
    const parent = depth > 0 ? $in.node(depth) : null;
    if (parent && isItem(parent) && $in.index(depth) === 0 && depth >= 2) {
      reach.lists.add($in.before(depth - 1));
    } else if (node.type.name === 'paragraph' && !insideItem(state, pos)) {
      reach.loose.push(pos);
    }
  };
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    note(pos, node);
    return false;
  });
  return reach;
}

/** True when the block at `pos` sits anywhere inside a list item. */
function insideItem(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) if (isItem($pos.node(d))) return true;
  return false;
}

/** `node` rebuilt with every list at a start position in `lists` made `kind`. */
function rebuilt(node: ProseMirrorNode, pos: number, lists: ReadonlySet<number>, kind: NodeType, item: NodeType): ProseMirrorNode {
  if (node.isTextblock || node.isLeaf) return node;
  const children: ProseMirrorNode[] = [];
  let changed = false;
  node.forEach((child, offset) => {
    const next = rebuilt(child, pos + 1 + offset, lists, kind, item);
    if (next !== child) changed = true;
    children.push(next);
  });
  if (isList(node) && lists.has(pos) && node.type !== kind) {
    const items = children.map((child) => (isItem(child) && child.type !== item ? item.create(child.attrs, child.content, child.marks) : child));
    // Attributes the new kind has keep their value (a list's spacing); a list made numbered starts at 1.
    return kind.create(node.attrs, items, node.marks);
  }
  return changed ? node.copy(Fragment.fromArray(children)) : node;
}

/** Joins the list at `pos` with a list of its own kind right before or after it. */
function joinNeighbours(tr: Transaction, pos: number): void {
  const node = tr.doc.nodeAt(pos);
  if (!node || !isList(node)) return;
  const after = pos + node.nodeSize;
  if (tr.doc.nodeAt(after)?.type === node.type && canJoin(tr.doc, after)) tr.join(after);
  const $pos = tr.doc.resolve(pos);
  if ($pos.nodeBefore?.type === node.type && canJoin(tr.doc, pos)) tr.join(pos);
}

/** A position in `tr.doc` as of step `step`, to be mapped through the steps after it. */
interface Anchor { pos: number; step: number }

function mapped(tr: Transaction, at: Anchor): number {
  return tr.mapping.slice(at.step).map(at.pos);
}

/** Wraps each run of neighbouring loose paragraphs in a list of `kind`. Returns where the new lists start. */
function wrapLoose(tr: Transaction, loose: readonly number[], kind: NodeType): Anchor[] {
  // Runs of paragraphs side by side in one parent, last run first so earlier positions hold.
  const runs: { from: number; to: number }[] = [];
  for (const pos of loose) {
    const node = tr.doc.nodeAt(pos);
    if (!node) continue;
    const last = runs[runs.length - 1];
    if (last && last.to === pos && tr.doc.resolve(last.from).parent === tr.doc.resolve(pos).parent) last.to = pos + node.nodeSize;
    else runs.push({ from: pos, to: pos + node.nodeSize });
  }
  const made: Anchor[] = [];
  for (const run of runs.reverse()) {
    const $from = tr.doc.resolve(run.from);
    const range = new NodeRange($from, tr.doc.resolve(run.to), $from.depth);
    const wrapping = findWrapping(range, kind);
    if (!wrapping) continue;
    tr.wrap(range, wrapping);
    made.push({ pos: run.from, step: tr.steps.length });
  }
  return made;
}

/** The list commands TipTap's own toggle runs as. */
const TOGGLE: Record<ListKind, 'toggleBulletList' | 'toggleOrderedList' | 'toggleTaskList'> = {
  bulletList: 'toggleBulletList',
  orderedList: 'toggleOrderedList',
  taskList: 'toggleTaskList',
};

export const ListSwitch = Extension.create({
  name: 'filoListSwitch',
  // Ahead of the lists' own Ctrl+Shift+7 / 8 / 9.
  priority: 1000,

  addCommands() {
    return {
      switchList:
        (kindName: ListKind) =>
        ({ state, tr, dispatch, commands }: CommandProps): boolean => {
          const kind = state.schema.nodes[kindName];
          const item = state.schema.nodes[kindName === 'taskList' ? 'taskItem' : 'listItem'];
          if (!kind || !item) return false;
          const reach = reachOf(state);
          const changing = [...reach.lists].filter((pos) => state.doc.nodeAt(pos)?.type !== kind);
          if (reach.lists.size === 0 || (changing.length === 0 && reach.loose.length === 0)) {
            return commands[TOGGLE[kindName]]();
          }
          if (!dispatch) return true;
          // The outermost lists to rebuild: those with no reached list around them.
          const roots = [...reach.lists].filter((pos) => {
            const $pos = state.doc.resolve(pos);
            for (let d = $pos.depth; d > 0; d--) if (reach.lists.has($pos.before(d))) return false;
            return true;
          });
          // Rebuilding keeps every node's size, so positions hold across roots.
          for (const pos of roots) {
            const node = state.doc.nodeAt(pos);
            if (!node) continue;
            const next = rebuilt(node, pos, reach.lists, kind, item);
            if (next !== node) tr.replaceWith(pos, pos + node.nodeSize, next);
          }
          const made = wrapLoose(tr, reach.loose.map((pos) => tr.mapping.map(pos)), kind);
          // Neighbouring lists of the new kind become one, last first.
          const lists = [...roots.map((pos) => ({ pos, step: 0 })), ...made]
            .map((at) => mapped(tr, at))
            .sort((a, b) => b - a);
          for (const pos of lists) joinNeighbours(tr, pos);
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-8': () => this.editor.commands.switchList('bulletList'),
      'Mod-Shift-7': () => this.editor.commands.switchList('orderedList'),
      'Mod-Shift-9': () => this.editor.commands.switchList('taskList'),
    };
  },
});
