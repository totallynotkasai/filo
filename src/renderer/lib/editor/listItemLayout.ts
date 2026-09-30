import { Extension, type CommandProps } from '@tiptap/core';
import { TextAlign } from '@tiptap/extension-text-align';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { hasBlockLayout } from './blockLayout';

/**
 * No alignment or indent inside a list or checklist item.
 *
 * An aligned or indented paragraph is written as one line of HTML
 * (`blockLayout.ts`). In a list item that line swallowed the item's
 * sub-items: a Markdown HTML block runs to the next blank line, so the
 * sub-list became raw text inside it. In a checklist item the HTML was read
 * as Markdown text. Either way the note reopened with stray `-` or `1.`
 * lines, and read-only.
 *
 * DECISION (D2): Align doesn't apply inside a list (the toolbar's control is
 * disabled there and says why); a Select All + Center aligns only the text
 * outside lists. Indent inside a list nests the item, a Markdown list level,
 * as before. Whatever still brings a layout into a list (a paragraph turned
 * into a list item, a paste) has it cleared by `ListItemLayout`, so the
 * editor shows what the file will hold. Writing the whole list as HTML
 * instead would keep the alignment but lose the Markdown list for other apps.
 */

/** Items whose paragraphs never carry an alignment or indent. */
export const LIST_ITEM_TYPES: ReadonlySet<string> = new Set(['listItem', 'taskItem']);

/** Blocks that can carry an alignment or indent. */
const LAYOUT_BLOCKS: ReadonlySet<string> = new Set(['paragraph', 'heading']);

/** True when `node` sits directly in a list or checklist item. */
export function isListItem(node: ProseMirrorNode | null | undefined): boolean {
  return !!node && LIST_ITEM_TYPES.has(node.type.name);
}

/** Clears, in `tr`, the layout of every paragraph and heading inside a list item of `doc`. */
function clearLayoutInLists(doc: ProseMirrorNode, tr: Transaction): void {
  const walk = (node: ProseMirrorNode, start: number, inList: boolean): void => {
    node.forEach((child, offset) => {
      const pos = start + offset;
      if (inList && LAYOUT_BLOCKS.has(child.type.name)) {
        if (hasBlockLayout(child)) tr.setNodeMarkup(pos, undefined, { ...child.attrs, textAlign: null, indent: 0 });
        return;
      }
      if (!child.isTextblock && !child.isLeaf) walk(child, pos + 1, inList || isListItem(child));
    });
  };
  walk(doc, 0, false);
}

/** Keeps alignment and indent out of list items, whatever put them there. */
export const ListItemLayout = Extension.create({
  name: 'filoListItemLayout',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('filoListItemLayout'),
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const tr = newState.tr;
          clearLayoutInLists(newState.doc, tr);
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});

/**
 * TipTap's TextAlign, whose `setTextAlign` leaves list items alone. It fails
 * when nothing it touches can be aligned, so `can().setTextAlign(…)` says
 * whether the toolbar's Align control applies.
 */
export const FiloTextAlign = TextAlign.extend({
  addCommands() {
    return {
      ...this.parent?.(),
      setTextAlign:
        (alignment: string) =>
        ({ tr, state, dispatch }: CommandProps): boolean => {
          if (!this.options.alignments.includes(alignment)) return false;
          let found = false;
          for (const range of state.selection.ranges) {
            state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
              if (isListItem(node)) return false;
              if (!this.options.types.includes(node.type.name)) return true;
              found = true;
              if (dispatch && node.attrs.textAlign !== alignment) {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: alignment });
              }
              return false;
            });
          }
          return found;
        },
    };
  },
});
