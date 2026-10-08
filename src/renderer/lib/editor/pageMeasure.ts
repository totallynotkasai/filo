/**
 * pageMeasure — where a note's blocks lie, for the Document tab's page view
 * (`pageBreaks.ts`): px from the page column's top, as they would lie with no
 * page breaks.
 *
 * A measure reads the blocks' places off the layout. In a note of thousands
 * of blocks that is what typing waits on, so a measure starts from the last
 * one: the blocks before the first change keep their places, and the blocks
 * after it move by what the change added or took away, once the first and
 * the last of them are seen to have moved by exactly that. Only the changed
 * blocks, and those checks, are read.
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import type { LaidOutBlock, PageBreak } from './pageLayout';

/**
 * Nodes whose children can each start a page. A task item, a table and a
 * code block are kept whole: their children don't lie in plain block flow.
 */
const BREAKABLE_CONTAINERS = new Set(['bulletList', 'orderedList', 'taskList', 'listItem', 'blockquote']);

/**
 * Never moved to a new page: a rule's line sits in the band at the foot of
 * the page it follows, and moving it would leave the page above it short.
 */
const NEVER_MOVED = new Set(['horizontalRule']);

/** Sub-pixel differences in measuring are the same place. */
const SAME_PX = 0.5;

/** Up to this many changed blocks are looked up one by one; more, and the DOM is walked once. */
const LOOKUPS = 64;

interface Unit {
  pos: number;
  /** The position after the block. */
  end: number;
  target: number | null;
}

/** A block as measured, with no page breaks, and where it is in the note. */
export interface MeasuredBlock extends LaidOutBlock {
  pos: number;
  end: number;
}

export interface Measured {
  /** The note the blocks were measured in. */
  doc: ProseMirrorNode;
  blocks: MeasuredBlock[];
  /** The page column's width then. */
  width: number;
  /** The editor's height with the breaks then applied (null until known). */
  height: number | null;
}

/**
 * The blocks pages are laid out from, in document order, those that start
 * at or after `from` and before `to`: each block that isn't broken into its
 * children, with the element that takes its space (the outermost element it
 * is the first block of: a list starting with it).
 */
function collectUnits(doc: ProseMirrorNode, from = 0, to = Infinity): Unit[] {
  const units: Unit[] = [];
  const walk = (parent: ProseMirrorNode, contentStart: number, firstTarget: number | null): void => {
    parent.forEach((child, offset, index) => {
      const pos = contentStart + offset;
      const end = pos + child.nodeSize;
      if (end <= from || pos >= to) return;
      const target = index === 0 ? firstTarget : pos;
      if (BREAKABLE_CONTAINERS.has(child.type.name) && child.childCount > 0) {
        walk(child, pos + 1, target);
      } else if (!NEVER_MOVED.has(child.type.name) && pos >= from) {
        units.push({ pos, end, target });
      }
    });
  };
  walk(doc, 0, null);
  return units;
}

/**
 * The elements of `node`'s children, read off `el`'s child elements with the
 * widgets (a gap cursor) left out; null when they don't pair one to one.
 * Every container pages break inside holds its children directly (`ul`,
 * `li`, `blockquote`), so they pair.
 */
function childElements(el: Element, node: ProseMirrorNode): Element[] | null {
  const out: Element[] = [];
  for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
    if (!child.classList.contains('ProseMirror-widget')) out.push(child);
  }
  return out.length === node.childCount ? out : null;
}

/**
 * Every block's element, by position, walking the DOM beside the note once:
 * looking each block up by its position (`nodeDOM`) scans the blocks before
 * it, which in a note of thousands of blocks took most of a measure. A node
 * view that doesn't hold its children directly is looked up.
 */
function elementsByPos(view: EditorView): Map<number, Element> {
  const out = new Map<number, Element>();
  const walk = (parent: ProseMirrorNode, contentStart: number, parentDom: Element | null): void => {
    const doms = parentDom ? childElements(parentDom, parent) : null;
    parent.forEach((child, offset, index) => {
      const pos = contentStart + offset;
      const dom = doms ? doms[index] : view.nodeDOM(pos);
      if (!(dom instanceof Element)) return;
      out.set(pos, dom);
      if (BREAKABLE_CONTAINERS.has(child.type.name)) walk(child, pos + 1, dom);
    });
  };
  walk(view.state.doc, 0, view.dom);
  return out;
}

interface Change {
  /** Where the note first differs (null: it doesn't). */
  from: number | null;
  /** Where the unchanged rest of the note starts now. */
  to: number;
  /** How much longer the note is now. */
  sizeDelta: number;
  /** Whether every difference lies inside one paragraph or heading. */
  inOneTextblock: boolean;
}

function changeSince(before: ProseMirrorNode, after: ProseMirrorNode): Change {
  const sizeDelta = after.content.size - before.content.size;
  const from = before.content.findDiffStart(after.content);
  if (from === null) return { from: null, to: 0, sizeDelta, inOneTextblock: true };
  const end = before.content.findDiffEnd(after.content);
  if (!end) return { from, to: after.content.size, sizeDelta, inOneTextblock: false };
  // The two ends overlap where the change repeats the text around it.
  const endBefore = Math.max(end.a, from);
  const endAfter = Math.max(end.b, from);
  const $before = before.resolve(from);
  const $after = after.resolve(from);
  const inOneTextblock = $before.parent.isTextblock && $before.sameParent(before.resolve(endBefore))
    && $after.parent.isTextblock && $after.sameParent(after.resolve(endAfter));
  return { from, to: endAfter, sizeDelta, inOneTextblock };
}

/** The break space above a position, and a block's own, from the breaks shown now. */
function breakSpace(breaks: readonly PageBreak[]): { above(pos: number): number; own(pos: number): number } {
  const sums: number[] = [0];
  for (const b of breaks) sums.push(sums[sums.length - 1]! + b.shift);
  /** How many breaks lie before `pos`. */
  const before = (pos: number): number => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid]!.target < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    above: (pos) => sums[before(pos)]!,
    own: (pos) => {
      const at = breaks[before(pos)];
      return at && at.target === pos ? at.shift : 0;
    },
  };
}

/** The first index in `blocks` whose block satisfies `ok`, which holds from some index on. */
function firstWhere(blocks: readonly MeasuredBlock[], ok: (b: MeasuredBlock) => boolean): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(blocks[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function samePlace(a: LaidOutBlock | null, b: LaidOutBlock, delta: number): boolean {
  return a !== null && Math.abs(a.top - b.top - delta) < SAME_PX && Math.abs(a.bottom - b.bottom - delta) < SAME_PX;
}

/**
 * The note's blocks in `column`, with `breaks` (the breaks shown now, in
 * document order) taken back out. `last` is the previous measure at this
 * column width, or null to read every block. 'unchanged' when the note was
 * only typed in inside one paragraph and the editor's height is as it was:
 * no block moved.
 */
export function measureBlocks(
  view: EditorView,
  column: HTMLElement,
  breaks: readonly PageBreak[],
  last: Measured | null,
): MeasuredBlock[] | 'unchanged' {
  const doc = view.state.doc;
  const change = last ? changeSince(last.doc, doc) : null;
  if (last && change?.inOneTextblock && last.height !== null && view.dom.offsetHeight === last.height) return 'unchanged';

  const columnRect = column.getBoundingClientRect();
  // CSS zoom (and any transform) scales the rects but not the layout.
  const scale = columnRect.width / column.offsetWidth || 1;
  const space = breakSpace(breaks);
  const read = (unit: Unit, dom: Node | null | undefined): MeasuredBlock | null => {
    if (!(dom instanceof HTMLElement)) return null;
    const rect = dom.getBoundingClientRect();
    // Not laid out (hidden, or no layout engine at all).
    if (rect.width === 0 && rect.height === 0) return null;
    const above = space.above(unit.pos);
    // A block's own padding moves its bottom, not its top.
    return {
      pos: unit.pos,
      end: unit.end,
      top: (rect.top - columnRect.top) / scale - above,
      bottom: (rect.bottom - columnRect.top) / scale - above - space.own(unit.pos),
      target: unit.target,
    };
  };
  /** Reads `units`, looking a few up by position or walking the DOM for many. */
  const readAll = (units: readonly Unit[], out: MeasuredBlock[]): void => {
    const doms = units.length > LOOKUPS ? elementsByPos(view) : null;
    for (const unit of units) {
      const block = read(unit, doms ? doms.get(unit.pos) : view.nodeDOM(unit.pos));
      if (block) out.push(block);
    }
  };

  if (last && change && change.from !== null) {
    const { from, to, sizeDelta } = change;
    // Before the change: kept, as long as the last of them still stands
    // where it stood (nothing above it moved).
    let kept = firstWhere(last.blocks, (b) => b.end > from);
    if (kept > 0) {
      const b = last.blocks[kept - 1]!;
      if (!samePlace(read(b, view.nodeDOM(b.pos)), b, 0)) kept = 0;
    }
    // After the change: the blocks it didn't touch, now `sizeDelta` further
    // on, moved by what it added, once the first and the last of them are
    // seen to have moved by just that.
    const oldTo = to - sizeDelta;
    const tail = firstWhere(last.blocks, (b) => b.pos >= oldTo);
    const firstTail = last.blocks[tail];
    const lastTail = last.blocks[last.blocks.length - 1]!;
    const moved = (b: MeasuredBlock): Unit => ({
      pos: b.pos + sizeDelta,
      end: b.end + sizeDelta,
      target: b.target === null ? null : b.target + sizeDelta,
    });
    let delta = 0;
    let tailHolds = true;
    if (firstTail) {
      const firstRead = read(moved(firstTail), view.nodeDOM(firstTail.pos + sizeDelta));
      delta = firstRead ? firstRead.top - firstTail.top : 0;
      tailHolds = samePlace(firstRead, firstTail, delta)
        && samePlace(read(moved(lastTail), view.nodeDOM(lastTail.pos + sizeDelta)), lastTail, delta)
        && last.blocks.slice(tail).every((b) => b.target === null || b.target >= oldTo);
    }
    if (tailHolds) {
      const blocks = last.blocks.slice(0, kept);
      const start = kept > 0 ? last.blocks[kept - 1]!.end : 0;
      readAll(collectUnits(doc, start, firstTail ? firstTail.pos + sizeDelta : Infinity), blocks);
      for (let i = tail; i < last.blocks.length; i++) {
        const b = last.blocks[i]!;
        blocks.push({ ...moved(b), top: b.top + delta, bottom: b.bottom + delta });
      }
      return blocks;
    }
  }

  const blocks: MeasuredBlock[] = [];
  readAll(collectUnits(doc), blocks);
  return blocks;
}
