import { Node } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * A tab character typed into a note: one inline item, so Backspace removes it
 * in one press, as in a word processor.
 *
 * It can't be a plain `\t` in a text node: ProseMirror collapses whitespace
 * when it reads the HTML markdown-it renders, so a tab would come back from
 * the file as a space.
 *
 * In the file it is a tab character. Only where Markdown would lose it, at the
 * start or end of a line (a leading tab makes the line a code block, and
 * headings, list items and continuation lines drop leading whitespace), it is
 * written as the entity `&#9;`, which markdown-it reads back as a tab. A tab
 * at the edge of a bold or italic run is saved outside the run
 * (`withEdgeTabsOutsideRuns`).
 */

interface TabSerializeState {
  write(content: string): void;
}

/** True when only tabs sit between this tab and the start or the end of its line. */
function atLineEdge(parent: ProseMirrorNode, index: number): boolean {
  const isTab = (i: number): boolean => parent.child(i).type.name === 'tab';
  const isBreak = (i: number): boolean => parent.child(i).type.name === 'hardBreak';
  let before = index - 1;
  while (before >= 0 && isTab(before)) before--;
  if (before < 0 || isBreak(before)) return true;
  let after = index + 1;
  while (after < parent.childCount && isTab(after)) after++;
  return after >= parent.childCount || isBreak(after);
}

/** Marks written as Markdown delimiter runs (`**`, `*`, `~~`). */
const DELIMITER_MARKS = new Set(['bold', 'italic', 'strike']);

/**
 * `block` as it is saved: a tab that opens or closes a bold, italic or
 * strikethrough run is taken out of that run. Written inside it, the
 * delimiter would sit next to whitespace (`**bold\t**`), which Markdown
 * doesn't read as emphasis, so the run broke on reopen; outside it the file
 * reads `**bold**\t`, and the tab looks the same. A tab inside a run keeps its
 * marks. Returns `block` itself when nothing changes.
 */
export function withEdgeTabsOutsideRuns(block: ProseMirrorNode): ProseMirrorNode {
  const children: ProseMirrorNode[] = [];
  block.forEach((child) => children.push(child));
  let changed = false;
  // Repeat until stable: unmarking the last of several tabs puts the one
  // before it at the run's edge.
  for (let moved = true; moved; ) {
    moved = false;
    children.forEach((child, i) => {
      if (child.type.name !== 'tab') return;
      const prev = children[i - 1]?.marks ?? [];
      const next = children[i + 1]?.marks ?? [];
      const keep = child.marks.filter(
        (m) => !DELIMITER_MARKS.has(m.type.name) || (m.isInSet(prev) && m.isInSet(next)),
      );
      if (keep.length === child.marks.length) return;
      children[i] = child.mark(keep);
      moved = true;
      changed = true;
    });
  }
  return changed ? block.copy(Fragment.fromArray(children)) : block;
}

/** Every tab in `root`'s text, outside code, as a tab element the parse rule reads. */
export function tabsToElements(root: HTMLElement): void {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    if (text.data.includes('\t') && !text.parentElement?.closest('pre, code')) texts.push(text);
  }
  for (const text of texts) {
    const parts = text.data.split('\t');
    const frag = root.ownerDocument.createDocumentFragment();
    parts.forEach((part, i) => {
      if (i > 0) {
        const tab = root.ownerDocument.createElement('span');
        tab.setAttribute('data-filo-tab', '');
        tab.textContent = '\t';
        frag.appendChild(tab);
      }
      if (part) frag.appendChild(root.ownerDocument.createTextNode(part));
    });
    text.replaceWith(frag);
  }
}

export const TabChar = Node.create({
  name: 'tab',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'span[data-filo-tab]' }];
  },

  renderHTML() {
    return ['span', { 'data-filo-tab': '', class: 'filo-tab' }, '\t'];
  },

  renderText() {
    return '\t';
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: TabSerializeState, _node: ProseMirrorNode, parent: ProseMirrorNode, index: number): void {
          state.write(atLineEdge(parent, index) ? '&#9;' : '\t');
        },
        parse: {
          updateDOM(element: HTMLElement): void {
            tabsToElements(element);
          },
        },
      },
    };
  },
});
