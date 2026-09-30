import { Extension } from '@tiptap/core';
import { EMPTY_ITEM_TEXT_ATTR } from './taskItems';

/**
 * A list parsed from HTML is tight unless one of its own items holds a plain
 * `<p>` (the loose-list shape markdown-it renders). A loose list nested in an
 * item says nothing about the list around it: counted, a tight list holding
 * one reloaded loose, gained blank lines on the next save, and opened
 * read-only. A `<p style=…>` is an aligned paragraph an earlier Filo wrote in
 * a list item as an HTML line (`blockLayout.ts`), which a tight list could
 * hold, so it doesn't make the list loose either; nor does the empty
 * paragraph the parse gives an item with no text of its own (`taskItems.ts`).
 */
function isTightListElement(el: HTMLElement): boolean {
  return el.getAttribute('data-tight') === 'true' || !el.querySelector(`:scope > li > p:not([style]):not([${EMPTY_ITEM_TEXT_ATTR}])`);
}

/**
 * Give `taskList` the `tight` attribute bullet/ordered lists
 * already get from tiptap-markdown's `MarkdownTightLists` (whose `listTypes` is
 * hard-coded to `['bulletList', 'orderedList']` and not configurable).
 *
 * prosemirror-markdown's `renderList` reads `node.attrs.tight`; without it a
 * task list falls back to the loose default, writing every checklist with
 * blank lines between items (`- [ ] a\n\n- [ ] b`) so a tight checklist from
 * Obsidian / GitHub round-trips lossy (read-only). An existing loose checklist
 * stays loose; a checklist created in the editor is tight.
 */
export const FiloTaskListTight = Extension.create({
  name: 'filoTaskListTight',
  addGlobalAttributes() {
    return [
      {
        types: ['taskList'],
        attributes: {
          tight: {
            default: true,
            parseHTML: isTightListElement,
            renderHTML: (attrs: { tight?: boolean }) => ({ 'data-tight': attrs.tight ? 'true' : null }),
          },
        },
      },
    ];
  },
});

/**
 * Replaces tiptap-markdown's `tight` parse rule for bullet and numbered lists
 * with {@link isTightListElement}, keeping its default and rendering. Must be
 * registered after the Markdown extension so this definition wins.
 */
export const FiloListTight = Extension.create({
  name: 'filoListTight',
  addGlobalAttributes() {
    return [
      {
        types: ['bulletList', 'orderedList'],
        attributes: {
          tight: {
            default: true,
            parseHTML: isTightListElement,
            renderHTML: (attrs: { tight?: boolean }) => ({
              class: attrs.tight ? 'tight' : null,
              'data-tight': attrs.tight ? 'true' : null,
            }),
          },
        },
      },
    ];
  },
});
