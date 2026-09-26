import { Extension } from '@tiptap/core';

/**
 * A list parsed from HTML is tight unless an item holds a plain `<p>` (the
 * loose-list shape markdown-it renders). A `<p style=…>` is an aligned or
 * indented paragraph saved as an HTML line (`blockLayout.ts`), which a tight
 * list can hold, so it doesn't make the list loose. Without that exception a
 * tight list with one centred item would reload loose, gain blank lines on the
 * next save, and open read-only as a lossy note.
 */
function isTightListElement(el: HTMLElement): boolean {
  return el.getAttribute('data-tight') === 'true' || !el.querySelector('p:not([style])');
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
