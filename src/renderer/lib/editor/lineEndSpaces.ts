import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { isLineBreak } from './softBreak';

/**
 * Spaces typed at the end of a line, as they are saved.
 *
 * Markdown drops spaces at the end of a paragraph, a heading or a table
 * cell, and before a single newline it drops one and reads two or more as a
 * hard line break. (A tab is a node of its own, written `&#9;` where it would
 * be dropped, `tabNode.ts`.) Typed there, they were saved and then gone once the
 * note reopened (or a line break, saved later as `\`), so the next save of
 * the note wrote different bytes. They are left out of the file:
 * - before a block is written, from the text ending each line, so what
 *   stands before them (a tab, a word) ends the line and is written as it
 *   should be there (`withLineEndSpacesDropped`);
 * - after it is written, wherever the writer noted a line of text ends
 *   (`NoteSerializerState.markLineEnd`), as a last check (`withoutLineEndSpaces`).
 * Spaces a closing tag follows (`<u>a  </u>`) are kept: Markdown keeps them.
 */

/** Marks whose whitespace is written bare (Markdown delimiters push it out of the run). */
const BARE_MARKS: ReadonlySet<string> = new Set(['bold', 'italic', 'strike']);

/**
 * True when a tag closing right after `node`, at the end of its line, keeps
 * the spaces ending it (`<u>a  </u>`, `[a  ](…)`): one of its marks stops
 * there (`next` is the soft break after it, or nothing at the end). A bold,
 * italic or strikethrough run on it pushes the spaces out of every tag.
 */
function keptByTag(node: ProseMirrorNode, next: ProseMirrorNode | undefined): boolean {
  if (node.marks.some((m) => BARE_MARKS.has(m.type.name))) return false;
  return node.marks.some((m) => !next || !m.isInSet(next.marks));
}

/** True when the inline child at `index` ends a line: before a soft break (`softBreaks`), or with only line breaks after it. */
function endsLine(children: readonly ProseMirrorNode[], index: number, softBreaks: boolean): boolean {
  const next = children[index + 1];
  if (!next) return true;
  if (softBreaks && next.type.name === 'softBreak') return true;
  return children.slice(index + 1).every(isLineBreak);
}

/**
 * `block` without the spaces ending its lines, where no tag keeps them.
 * `softBreaks`: a soft break ends a line (a paragraph's is a bare newline; a
 * heading's is `<br>`, before which spaces stay). A line left empty goes
 * too, its break staying. A block that would be left with no text (a line of
 * only spaces) is left as it is: its opening space is written `&#32;`, which
 * reads back, and an emptied list item would lose its sub-list. Returns
 * `block` itself when nothing changes.
 */
export function withLineEndSpacesDropped(block: ProseMirrorNode, softBreaks = true): ProseMirrorNode {
  const children: ProseMirrorNode[] = [];
  block.forEach((child) => children.push(child));
  let changed = false;
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < children.length && !again; i++) {
      const child = children[i] as ProseMirrorNode;
      if (!child.isText || !endsLine(children, i, softBreaks)) continue;
      const next = children[i + 1];
      if (keptByTag(child, softBreaks && next?.type.name === 'softBreak' ? next : undefined)) continue;
      const text = (child.text ?? '').replace(/ +$/, '');
      if (text === child.text) continue;
      if (text) children[i] = child.cut(0, text.length);
      else children.splice(i, 1);
      changed = again = true;
    }
  }
  // Line breaks left at the end aren't written, and a tab before them then
  // ends the block (written `&#9;`).
  while (children.length > 0 && isLineBreak(children[children.length - 1])) {
    children.pop();
    changed = true;
  }
  if (!changed || children.every(isLineBreak)) return block;
  return block.copy(Fragment.fromArray(children));
}

/**
 * `node` (a block written as HTML: an aligned paragraph, a table Markdown
 * can't hold) without the plain spaces ending each paragraph or heading in
 * it. The load drops spaces left bare at the end of a `<p>` (ones
 * inside a tag, `<u>a </u>`, or before a `<br>` stay). Code is left alone.
 * Returns `node` itself when nothing changes.
 */
export function withBlockEndSpacesTrimmed(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isTextblock) {
    const last = node.lastChild;
    if (node.type.spec.code || !last?.isText || last.marks.length > 0) return node;
    let text = (last.text ?? '').replace(/ +$/, '');
    // A line of only spaces keeps one: opening a line it is written as a
    // lead space, which reads back (`leadSpace.ts`).
    const startsLine = node.childCount === 1 || isLineBreak(node.child(node.childCount - 2));
    if (!text && startsLine) text = ' ';
    if (text === last.text) return node;
    const children: ProseMirrorNode[] = [];
    node.forEach((child) => children.push(child));
    children.pop();
    if (text) children.push(node.type.schema.text(text));
    return node.copy(Fragment.fromArray(children));
  }
  if (node.isLeaf) return node;
  const children: ProseMirrorNode[] = [];
  let changed = false;
  node.forEach((child) => {
    const next = withBlockEndSpacesTrimmed(child);
    if (next !== child) changed = true;
    children.push(next);
  });
  return changed ? node.copy(Fragment.fromArray(children)) : node;
}

/**
 * `markdown` without the spaces right before each of `lineEnds`.
 * `removed(at, count)` is told of each cut, the last one first, so positions
 * recorded in the same output can follow.
 */
export function withoutLineEndSpaces(
  markdown: string,
  lineEnds: readonly number[],
  removed: (at: number, count: number) => void,
): string {
  const ends = [...new Set(lineEnds)].sort((a, b) => b - a);
  const cuts: [number, number][] = [];
  let floor = Infinity;
  for (const end of ends) {
    if (end > floor) continue;
    let start = end;
    while (start > 0 && markdown[start - 1] === ' ') start--;
    if (start === end) continue;
    cuts.push([start, end]);
    removed(start, end - start);
    floor = start;
  }
  if (cuts.length === 0) return markdown;
  let out = '';
  let from = 0;
  for (const [start, end] of cuts.reverse()) {
    out += markdown.slice(from, start);
    from = end;
  }
  return out + markdown.slice(from);
}
