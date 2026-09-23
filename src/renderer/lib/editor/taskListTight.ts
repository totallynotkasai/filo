import { Extension } from '@tiptap/core';

/**
 * Audit-19 UX-7 — give `taskList` the `tight` attribute bullet/ordered lists
 * already get from tiptap-markdown's `MarkdownTightLists` (whose `listTypes` is
 * hard-coded to `['bulletList', 'orderedList']` and not configurable).
 *
 * prosemirror-markdown's `renderList` reads `node.attrs.tight`; without it a
 * task list fell back to the loose default, so Filo wrote every checklist with
 * blank lines between items (`- [ ] a\n\n- [ ] b`) and a tight checklist from
 * Obsidian / GitHub round-tripped lossy (read-only). A list parsed from HTML is
 * tight unless its items contain `<p>` (the loose-list shape), so an existing
 * loose checklist stays loose; a checklist created in the editor is tight.
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
            parseHTML: (el: HTMLElement) => el.getAttribute('data-tight') === 'true' || !el.querySelector('p'),
            renderHTML: (attrs: { tight?: boolean }) => ({ 'data-tight': attrs.tight ? 'true' : null }),
          },
        },
      },
    ];
  },
});
