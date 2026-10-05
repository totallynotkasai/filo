import { Fragment, Mark, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { isLineBreak, withBreakMarksTrimmed } from './softBreak';

/**
 * Whitespace between two differently formatted words, as it is saved.
 *
 * `**`, `*` and `~~` can't close after a space or open before one, so
 * prosemirror-markdown moves whitespace out of a bold, italic or
 * strikethrough run and writes it beside the run, inside whatever marks are
 * still open there. Usually those are the space's own (italic stays open
 * around a link inside an italic phrase). Sometimes they aren't:
 * - make "Aria Kasai" bold, then colour "Aria" red and "Kasai" blue: the
 *   colour is written outside the `**`, so the bold space between the words
 *   was written inside the red span, `**Aria **` couldn't close and became
 *   `<strong>Aria </strong>`, and the note reopened read-only;
 * - Ctrl+B on "two " inside an underlined phrase: the space was written after
 *   the underline closed, which left a gap in it.
 *
 * Before a block is written, its inline content is run through the writer's
 * own bookkeeping (`misplacedSpace`, which follows `renderInline`). Where a
 * space would be written with other marks than its own, it keeps a bold,
 * italic or strikethrough mark only where Markdown can hold it there (both
 * its neighbours carry the mark, with the same marks outside it), and keeps
 * its other marks (an underline, a highlight, a colour), which HTML can hold
 * around a space. A block the writer already writes right is left alone.
 * A space shows bold or italic as nothing; a struck one between two
 * differently formatted words loses the line there (KNOWN_LIMITATIONS #50).
 */

/** The flags of a mark's Markdown writer this follows (prosemirror-markdown's `MarkSerializerSpec`). */
export interface MarkFlags {
  mixable?: boolean;
  expelEnclosingWhitespace?: boolean;
  escape?: boolean;
}

export type MarkFlagSpecs = Readonly<Record<string, MarkFlags | undefined>>;

/** prosemirror-markdown's flags for the marks Filo writes as Markdown, when no writer's specs are given. */
const DEFAULT_FLAGS: MarkFlagSpecs = {
  bold: { mixable: true, expelEnclosingWhitespace: true },
  italic: { mixable: true, expelEnclosingWhitespace: true },
  strike: { expelEnclosingWhitespace: true },
  link: { mixable: true },
  code: { escape: false },
};

const HARD_BREAK = 'hardBreak';

type FlagsOf = (mark: Mark) => MarkFlags;

/** Whitespace the writer moves out of a text node: which node, which end (or all of it), and its marks. */
interface Piece {
  index: number;
  side: 'lead' | 'trail';
  whole: boolean;
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return a.length === b.length && a.every((m) => m.isInSet(b));
}

/** The writer's `isMarkAhead`, step for step (it steps over a hard break and the node after it). */
function markAhead(block: ProseMirrorNode, from: number, marks: readonly Mark[]): boolean {
  for (let index = from; ; index++) {
    if (index >= block.childCount) return false;
    const next = block.child(index);
    if (next.type.name !== HARD_BREAK) return next.marks.length >= marks.length && Mark.sameSet(next.marks.slice(0, marks.length), marks);
    index++;
  }
}

/** The writer's reordering of mixable marks (bold, italic, link) to follow the ones already open. */
function reordered(marks: readonly Mark[], len: number, active: readonly Mark[], flagsOf: FlagsOf): readonly Mark[] {
  let out = marks.slice();
  outer: for (let i = 0; i < len; i++) {
    const mark = out[i];
    if (!mark || !flagsOf(mark).mixable) break;
    for (let j = 0; j < active.length; j++) {
      const other = active[j];
      if (!other || !flagsOf(other).mixable) break;
      if (mark.eq(other)) {
        if (i > j) out = out.slice(0, j).concat(mark).concat(out.slice(j, i)).concat(out.slice(i + 1, len));
        else if (j > i) out = out.slice(0, i).concat(out.slice(i + 1, j)).concat(mark).concat(out.slice(j, len));
        continue outer;
      }
    }
  }
  return out;
}

/**
 * True when `piece` is spaces or tabs ending a line, before a soft break or
 * at the block's end: Markdown drops them there, whatever their marks. (A
 * space opening a line is kept, as `&#32;`; so is one before a hard break,
 * `a  \`, and any other whitespace, a no-break space.)
 */
function droppedAtLineEnd(block: ProseMirrorNode, piece: Piece): boolean {
  if (piece.side !== 'trail' && !piece.whole) return false;
  const n = block.childCount;
  if (piece.index !== n - 1 && block.child(piece.index + 1).type.name !== 'softBreak') return false;
  const text = block.child(piece.index).text ?? '';
  return /^[ \t]*$/.test(piece.whole ? text : (/\s*$/.exec(text)?.[0] ?? ''));
}

/**
 * The first whitespace prosemirror-markdown (1.13) would write inside other
 * marks than its own, or null. Follows `renderInline`: the open marks, the
 * reordering of mixable marks, and the whitespace moved out of a run.
 */
function misplacedSpace(block: ProseMirrorNode, flagsOf: FlagsOf): Piece | null {
  const n = block.childCount;
  const active: Mark[] = [];
  let carried: { piece: Piece; marks: readonly Mark[] }[] = [];
  for (let index = 0; index <= n; index++) {
    const node = index < n ? block.child(index) : null;
    let marks: readonly Mark[] = node ? node.marks : [];
    if (node && node.type.name === HARD_BREAK) {
      const next = index + 1 < n ? block.child(index + 1) : null;
      marks = marks.filter((m) => !!next && m.isInSet(next.marks) && (!next.isText || /\S/.test(next.text ?? '')));
    }
    const inner = marks[marks.length - 1];
    const len = marks.length - (inner && flagsOf(inner).escape === false ? 1 : 0);
    marks = reordered(marks, len, active, flagsOf);
    let keep = 0;
    while (keep < Math.min(active.length, len) && marks[keep]?.eq(active[keep] as Mark)) keep++;

    const leading = carried;
    carried = [];
    let text = node?.isText ? (node.text ?? '') : null;
    let emptied = false;
    if (node && text !== null && marks.some((m) => flagsOf(m).expelEnclosingWhitespace && !active.slice(0, keep).some((a) => a.eq(m)))) {
      const [, lead = '', rest = ''] = /^(\s*)(.*)$/m.exec(text) ?? [];
      if (lead) {
        leading.push({ piece: { index, side: 'lead', whole: !rest }, marks: node.marks });
        text = rest;
        emptied = !rest;
      }
    }
    if (node && !emptied && text !== null && marks.some((m, i) => flagsOf(m).expelEnclosingWhitespace && !markAhead(block, index + 1, marks.slice(0, i + 1)))) {
      const [, rest = '', trail = ''] = /^(.*?)(\s*)$/m.exec(text) ?? [];
      if (trail) {
        carried.push({ piece: { index, side: 'trail', whole: !rest }, marks: node.marks });
        emptied = !rest;
      }
    }
    // A node left with nothing closes nothing; the whitespace moved out of
    // it, and out of the node before it, is written inside the marks open now.
    if (!emptied) active.length = keep;
    for (const { piece, marks: own } of leading) {
      if (!sameMarks(own, active) && !droppedAtLineEnd(block, piece)) return piece;
    }
    if (node && !emptied) {
      while (active.length < len) active.push(marks[active.length] as Mark);
    }
  }
  return null;
}

/** The marks of `node` nested outside `mark`, or null when `node` doesn't carry it (a line break carries nothing). */
function marksOutside(node: ProseMirrorNode | undefined, mark: Mark): readonly Mark[] | null {
  if (!node || isLineBreak(node)) return null;
  const at = node.marks.findIndex((m) => m.eq(mark));
  return at < 0 ? null : node.marks.slice(0, at);
}

/** The marks the whitespace at `index` keeps: a run's mark only where both neighbours carry it, with the same marks outside it. */
function keptMarks(children: readonly ProseMirrorNode[], index: number, flagsOf: FlagsOf): readonly Mark[] {
  const node = children[index];
  if (!node) return [];
  const kept: Mark[] = [];
  for (const mark of node.marks) {
    if (flagsOf(mark).expelEnclosingWhitespace) {
      const before = marksOutside(children[index - 1], mark);
      const after = marksOutside(children[index + 1], mark);
      if (!before || !after || !Mark.sameSet(before, kept) || !Mark.sameSet(after, kept)) continue;
    }
    kept.push(mark);
  }
  return kept;
}

/** The node at `piece.index` split so the piece's whitespace is a node of its own; and where it is. */
function splitOff(node: ProseMirrorNode, piece: Piece): { parts: ProseMirrorNode[]; at: number } {
  const text = node.text ?? '';
  if (piece.whole) return { parts: [node], at: 0 };
  const schema = node.type.schema;
  if (piece.side === 'lead') {
    const lead = /^\s*/.exec(text)?.[0] ?? '';
    return { parts: [schema.text(lead, node.marks), schema.text(text.slice(lead.length), node.marks)], at: 0 };
  }
  const trail = /\s*$/.exec(text)?.[0] ?? '';
  return { parts: [schema.text(text.slice(0, text.length - trail.length), node.marks), schema.text(trail, node.marks)], at: 1 };
}

/**
 * `block` as it is saved, with each space the writer would put inside other
 * marks than its own given the marks Markdown can hold there. `specs` are the
 * writer's mark specs (their flags), prosemirror-markdown's own when absent.
 * Returns `block` itself when nothing changes.
 */
export function withSpaceRunsUnwrapped(block: ProseMirrorNode, specs?: MarkFlagSpecs): ProseMirrorNode {
  const flagsOf: FlagsOf = (m) => specs?.[m.type.name] ?? DEFAULT_FLAGS[m.type.name] ?? {};
  let current = block;
  // Each pass takes a mark off one space, so this ends.
  for (;;) {
    const piece = misplacedSpace(current, flagsOf);
    if (!piece) break;
    const children: ProseMirrorNode[] = [];
    current.forEach((child) => children.push(child));
    const { parts, at } = splitOff(children[piece.index] as ProseMirrorNode, piece);
    children.splice(piece.index, 1, ...parts);
    const where = piece.index + at;
    const space = children[where] as ProseMirrorNode;
    let kept = keptMarks(children, where, flagsOf);
    // Where its neighbours don't account for it, the space keeps none of the
    // run marks: then nothing moves it, and it is written inside its own marks.
    if (kept.length === space.marks.length) kept = space.marks.filter((m) => !flagsOf(m).expelEnclosingWhitespace);
    if (kept.length === space.marks.length) break;
    children[where] = space.mark(kept);
    current = current.copy(Fragment.fromArray(children));
  }
  // A line break keeps only the marks on both its sides, spaces included.
  return current === block ? block : withBreakMarksTrimmed(current);
}
