import { Extension, type Editor } from '@tiptap/core';

/**
 * Tab and Shift+Tab inside a note (text tile and Document tab alike).
 *
 * Without this, Tab fell through to the browser, which moved focus to the
 * next focusable element on the canvas: the caret vanished and typing went
 * nowhere visible. Now Tab never leaves an editable note:
 * - a list or task item nests / un-nests, and a table moves between cells
 *   (their own handlers, which run first);
 * - in a code block Tab inserts a tab character;
 * - in a paragraph or heading Tab indents the block (Shift+Tab outdents),
 *   the same as the toolbar's indent buttons. Markdown has no indent, and a
 *   leading tab would turn the line into a code block on reload, so the
 *   block is saved as an HTML line (`blockLayout.ts`).
 *
 * Escape takes focus out of the editor to the tile (or just blurs, in a
 * Document tab), so a keyboard user can still Tab onwards. It doesn't consume
 * the key: the app's Escape (close the top menu or dialog) still runs.
 *
 * Low priority, so the list, table and tag-suggestion handlers see these keys
 * first.
 */
export const TabKeys = Extension.create({
  name: 'filoTabKeys',
  priority: 10,

  addKeyboardShortcuts() {
    const indent = (delta: 1 | -1) => ({ editor }: { editor: Editor }): boolean => {
      // A read-only note keeps the browser's Tab, so focus can move on.
      if (!editor.isEditable) return false;
      const { $from } = editor.state.selection;
      for (let d = $from.depth; d > 0; d--) {
        const name = $from.node(d).type.name;
        // A list item that can't nest further (the first item) or a table's
        // last cell: keep the key here rather than lose the caret.
        if (name === 'listItem' || name === 'taskItem' || name === 'tableCell' || name === 'tableHeader') return true;
      }
      if ($from.parent.type.name === 'codeBlock') {
        // insertText, not insertContent: a string there is parsed as HTML and
        // its whitespace dropped.
        if (delta === 1) editor.commands.command(({ tr }) => { tr.insertText('\t'); return true; });
        return true;
      }
      if (delta === 1) editor.commands.increaseIndent();
      else editor.commands.decreaseIndent();
      return true;
    };

    return {
      Tab: indent(1),
      'Shift-Tab': indent(-1),
      Escape: ({ editor }) => {
        const host = editor.view.dom.parentElement?.closest<HTMLElement>('[tabindex="0"]');
        if (host) host.focus({ preventScroll: true });
        else editor.commands.blur();
        return false;
      },
    };
  },
});
