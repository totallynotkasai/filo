import { Extension } from '@tiptap/core';
import { TaskList } from '@tiptap/extension-task-list';
import { serializeBulletList } from './listMarkers';

/**
 * How checklists are read from and written to the file.
 *
 * `markdown-it-task-lists` (registered by tiptap-markdown) makes a list item
 * a checklist item only when its text starts with `[ ] ` (or `[x] `), with a
 * space after the brackets. An empty item is written as `- [ ] `, and
 * Markdown drops the trailing space, so an empty checkbox (Enter after the
 * last task, then clicking away) came back as a bullet reading `[ ]`, and the
 * note opened read-only. The `filo-empty-task` rule gives such an item its
 * space back before the inline parse, where the plugin looks for it.
 *
 * A list the plugin marks as a checklist can still hold plain bullets (a
 * mixed GFM list). The editor's checklist holds only checklist items, so it
 * gained a filler checkbox. Such a list is split into runs of plain and
 * checklist items before the editor reads it.
 *
 * A list item (checklist or not) with no text of its own but a nested list
 * (an empty checkbox with sub-tasks) reaches the editor as an item whose
 * first block is the list. The editor's items start with a paragraph, and
 * ProseMirror doesn't add one: it moved the nested list out of the item. The
 * item is given its empty paragraph first (`fillEmptyItemText`), marked so
 * it doesn't make a tight list loose (`taskListTight.ts`).
 */

/** The slice of a markdown-it block token the rule reads. */
interface BlockToken {
  type: string;
  content: string;
}

/** The slice of markdown-it the rule is registered on. */
interface CoreRulerHost {
  core: {
    ruler: {
      before(beforeName: string, ruleName: string, fn: (state: { tokens: BlockToken[] }) => void): void;
    };
  };
}

/** A list item's whole text is a bare checkbox. */
const BARE_CHECKBOX = /^\[[ xX]\]$/;

/** Gives a list item that is only `[ ]` / `[x]` the space the task-list plugin needs. */
export function emptyTaskRule(state: { tokens: BlockToken[] }): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (!inline || inline.type !== 'inline' || tokens[i - 1]?.type !== 'paragraph_open' || tokens[i - 2]?.type !== 'list_item_open') continue;
    if (BARE_CHECKBOX.test(inline.content)) inline.content += ' ';
  }
}

/** Markdown-it instances already given the rule (tiptap-markdown calls `setup` on every parse). */
const prepared = new WeakSet<object>();

/** Splits every list that mixes checklist and plain items into runs of one kind. */
export function splitMixedTaskLists(root: Element): void {
  const isTask = (li: Element): boolean => li.classList.contains('task-list-item');
  for (const list of Array.from(root.querySelectorAll('ul.contains-task-list'))) {
    const items = Array.from(list.children).filter((c) => c.tagName === 'LI');
    if (items.every(isTask) || !items.some(isTask)) continue;
    const doc = list.ownerDocument;
    let run: HTMLUListElement | null = null;
    let runIsTask = false;
    for (const li of items) {
      if (!run || isTask(li) !== runIsTask) {
        runIsTask = isTask(li);
        run = doc.createElement('ul');
        if (runIsTask) {
          run.className = 'contains-task-list';
          run.setAttribute('data-type', 'taskList');
        }
        list.parentNode?.insertBefore(run, list);
      }
      run.appendChild(li);
    }
    list.remove();
  }
}

/** Marks the empty paragraph `fillEmptyItemText` adds. */
export const EMPTY_ITEM_TEXT_ATTR = 'data-filo-empty-item';

/** Gives each list item whose first block is not its text an empty paragraph to start with. */
export function fillEmptyItemText(root: Element): void {
  for (const li of Array.from(root.querySelectorAll('li'))) {
    let first: ChildNode | null = li.firstChild;
    // Spaces and newlines here are layout; a tab is the item's text (`tabNode.ts`).
    while (first && (first.nodeName === 'INPUT' || (first.nodeType === 3 && /^[ \r\n]*$/.test(first.textContent ?? '')))) {
      first = first.nextSibling;
    }
    if (!(first instanceof Element) || !/^(UL|OL|PRE|TABLE|BLOCKQUOTE|HR|H[1-6])$/.test(first.tagName)) continue;
    const p = li.ownerDocument.createElement('p');
    p.setAttribute(EMPTY_ITEM_TEXT_ATTR, '');
    li.insertBefore(p, first);
  }
}

/** Registers the empty-item rule, the mixed-list split and the empty-item fill with tiptap-markdown's parse. */
export const FiloListParse = Extension.create({
  name: 'filoListParse',
  addStorage() {
    return {
      markdown: {
        parse: {
          setup(md: CoreRulerHost): void {
            if (prepared.has(md)) return;
            prepared.add(md);
            md.core.ruler.before('inline', 'filo-empty-task', emptyTaskRule);
          },
          updateDOM(element: Element): void {
            splitMixedTaskLists(element);
            fillEmptyItemText(element);
          },
        },
      },
    };
  },
});

/**
 * Task list written with the bullet `listMarkerFor` picks. Its parse is
 * tiptap-markdown's own (the plugin and `data-type`), which this storage
 * leaves in place by not naming `parse`.
 */
export const FiloTaskList = TaskList.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: serializeBulletList,
      },
    };
  },
});
