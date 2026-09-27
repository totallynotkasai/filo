import { Extension, type Editor } from '@tiptap/core';

/**
 * Tab, Shift+Tab and Backspace inside a note (text tile and Document tab
 * alike), as in a word processor:
 * - Tab types a tab at the caret (`tabNode.ts`), replacing any selection
 *   within the line; Backspace deletes it like any character.
 * - With several lines selected, Tab indents them all and Shift+Tab outdents
 *   (the toolbar's indent, saved as an HTML line, `blockLayout.ts`).
 * - Shift+Tab removes the tab just before the caret, or else one indent step.
 * - Backspace at the start of an indented paragraph removes one indent step (`IndentBackspace`, below).
 * - A list or task item nests / un-nests and a table moves between cells
 *   (their own handlers, which run first); a code block gets a tab character.
 *
 * Tab never falls through to the browser in an editable note: that moved
 * focus to the next element on the canvas, and the caret vanished.
 *
 * Escape takes focus out of the editor to the tile (or just blurs, in a
 * Document tab), so a keyboard user can still Tab onwards. It doesn't consume
 * the key: the app's Escape (close the top menu or dialog) still runs.
 *
 * Low priority, so the list, table and tag-suggestion handlers see these keys
 * first.
 */

/**
 * Backspace at the start of an indented paragraph or heading removes one
 * indent step. A high priority, unlike `TabKeys`: the core Backspace would
 * otherwise run first and join the line to the one above.
 */
export const IndentBackspace = Extension.create({
  name: 'filoIndentBackspace',
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        const block = $from.parent;
        if (block.type.name !== 'paragraph' && block.type.name !== 'heading') return false;
        if (!(Number(block.attrs.indent) > 0)) return false;
        return editor.commands.decreaseIndent();
      },
    };
  },
});

/** The ancestor types whose own Tab handling runs first; Tab stays here if it did nothing. */
const TAB_OWNERS = new Set(['listItem', 'taskItem', 'tableCell', 'tableHeader']);

function inTabOwner(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) if (TAB_OWNERS.has($from.node(d).type.name)) return true;
  return false;
}

/** True when the selection reaches past its first block. */
function spansBlocks(editor: Editor): boolean {
  const { $from, $to } = editor.state.selection;
  return !$from.sameParent($to);
}

export const TabKeys = Extension.create({
  name: 'filoTabKeys',
  priority: 10,

  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        // A read-only note keeps the browser's Tab, so focus can move on.
        if (!editor.isEditable) return false;
        if (inTabOwner(editor)) return true;
        const { $from } = editor.state.selection;
        if ($from.parent.type.name === 'codeBlock') {
          // insertText, not insertContent: a string there is parsed as HTML
          // and its whitespace dropped.
          editor.commands.command(({ tr }) => { tr.insertText('\t'); return true; });
          return true;
        }
        if (spansBlocks(editor)) {
          editor.commands.increaseIndent();
          return true;
        }
        editor.commands.insertContent({ type: 'tab' });
        return true;
      },

      'Shift-Tab': ({ editor }) => {
        if (!editor.isEditable) return false;
        if (inTabOwner(editor)) return true;
        const { selection } = editor.state;
        const { $from, empty } = selection;
        if ($from.parent.type.name === 'codeBlock') {
          if (empty && $from.parent.textBetween(0, $from.parentOffset).endsWith('\t')) {
            editor.commands.deleteRange({ from: $from.pos - 1, to: $from.pos });
          }
          return true;
        }
        if (spansBlocks(editor)) {
          editor.commands.decreaseIndent();
          return true;
        }
        if (empty && $from.nodeBefore?.type.name === 'tab') {
          editor.commands.deleteRange({ from: $from.pos - 1, to: $from.pos });
          return true;
        }
        editor.commands.decreaseIndent();
        return true;
      },

      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        // Deleted here, not left to the browser: its contenteditable handling
        // next to a non-editable span is unreliable.
        if (empty && $from.nodeBefore?.type.name === 'tab') {
          return editor.commands.deleteRange({ from: $from.pos - 1, to: $from.pos });
        }
        return false;
      },

      Delete: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.nodeAfter?.type.name !== 'tab') return false;
        return editor.commands.deleteRange({ from: $from.pos, to: $from.pos + 1 });
      },

      Escape: ({ editor }) => {
        const host = editor.view.dom.parentElement?.closest<HTMLElement>('[tabindex="0"]');
        if (host) host.focus({ preventScroll: true });
        else editor.commands.blur();
        return false;
      },
    };
  },
});
