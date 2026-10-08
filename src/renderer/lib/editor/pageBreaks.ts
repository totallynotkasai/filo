/**
 * pageBreaks — the page view of a note editor in a Document tab. It measures
 * where the note's blocks lie (`pageMeasure.ts`), asks `layoutPages` where
 * the pages break, and puts each break's space above its block as a
 * decoration. A decoration is drawn, never part of the document, so the
 * note's Markdown, its saves and its undo history never see a page.
 *
 * The space is padding (`--filo-page-break`, applied by the Document tab's
 * stylesheet), not margin: a margin collapses with the margin of the block
 * above, so the space it adds depends on both and can't be measured back
 * out. Padding adds exactly its height, so the blocks' places with no breaks
 * are their measured places less the breaks above them, and a measure never
 * has to take the breaks off first (which would move the page under the
 * reader).
 */
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/core';
import { layoutPages, sameBreaks, samePages, type PageBreak, type PageRect } from './pageLayout';
import { measureBlocks, type Measured } from './pageMeasure';

/** The space between two page cards, px. */
export const PAGE_GAP = 24;

/** Pages keep A4's proportions at whatever width the page column has. */
const PAGE_ASPECT = Math.SQRT2;

/**
 * How long a measure waits: until edits pause, and at least this often while
 * they don't. A long note's measure lays out and reads more, so it waits for
 * a longer pause, and typing in it is held up less often.
 */
export function measureWaits(blocks: number): { debounce: number; maxWait: number } {
  if (blocks < 500) return { debounce: 60, maxWait: 250 };
  if (blocks < 2000) return { debounce: 150, maxWait: 600 };
  return { debounce: 300, maxWait: 1200 };
}

const pageBreaksKey = new PluginKey<DecorationSet>('filoPageBreaks');

interface BreakSpec {
  pageBreakShift: number;
}

/** Up to this many changed breaks are swapped one by one (`withBreaks`). */
const SWAP_AT_MOST = 16;

function roundPx(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The node at each of `targets` (in document order), walking the note's
 * blocks once: `doc.nodeAt` scans the blocks before its position each time.
 */
function nodesAt(doc: ProseMirrorNode, targets: readonly number[]): Array<ProseMirrorNode | null> {
  const out: Array<ProseMirrorNode | null> = [];
  let index = 0;
  let pos = 0;
  for (const target of targets) {
    while (index < doc.childCount && pos + doc.child(index).nodeSize <= target) pos += doc.child(index++).nodeSize;
    if (index >= doc.childCount || target < pos) out.push(null);
    else if (target === pos) out.push(doc.child(index));
    else out.push(doc.child(index).nodeAt(target - pos - 1));
  }
  return out;
}

function breakDecorations(doc: ProseMirrorNode, breaks: readonly PageBreak[]): Decoration[] {
  const decorations: Decoration[] = [];
  const nodes = nodesAt(doc, breaks.map((b) => b.target));
  for (const [i, { target, shift }] of breaks.entries()) {
    const node = nodes[i];
    if (!node) continue;
    const px = roundPx(shift);
    const spec: BreakSpec = { pageBreakShift: px };
    decorations.push(Decoration.node(target, target + node.nodeSize, {
      class: 'filo-page-break',
      style: `--filo-page-break: ${px}px`,
    }, spec));
  }
  return decorations;
}

/**
 * `set` showing `breaks` instead. An edit often changes only the break on
 * the page it is on, the breaks below keeping their blocks and their space:
 * then only the breaks that differ are swapped, as building the set reads
 * every block of the note for every break. When most differ (a line more on
 * the first page pushes a block onto the next page on every page), the set
 * is built again, which costs less than swapping them all.
 */
function withBreaks(set: DecorationSet, doc: ProseMirrorNode, breaks: readonly PageBreak[]): DecorationSet {
  const shown = set.find().sort((a, b) => a.from - b.from);
  const stale: Decoration[] = [];
  const fresh: PageBreak[] = [];
  let i = 0;
  for (const b of breaks) {
    while (i < shown.length && shown[i]!.from < b.target) stale.push(shown[i++]!);
    // A shown break covers its whole block: the set drops one whose block an
    // edit split or joined when it maps the decorations over the edit.
    const d = shown[i];
    if (d && d.from === b.target && (d.spec as BreakSpec).pageBreakShift === roundPx(b.shift)) i++;
    else fresh.push(b);
  }
  while (i < shown.length) stale.push(shown[i++]!);
  if (stale.length === 0 && fresh.length === 0) return set;
  if (stale.length > SWAP_AT_MOST) return DecorationSet.create(doc, breakDecorations(doc, breaks));
  return set.remove(stale).add(doc, breakDecorations(doc, fresh));
}

/** The page breaks the editor shows now, in document order. */
export function currentPageBreaks(state: EditorState): PageBreak[] {
  const set = pageBreaksKey.getState(state);
  if (!set) return [];
  return set.find()
    .map((d) => ({ target: d.from, shift: (d.spec as BreakSpec).pageBreakShift ?? 0 }))
    .sort((a, b) => a.target - b.target);
}

function pageBreaksPlugin(onDocChanged: () => void): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: pageBreaksKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const next = tr.getMeta(pageBreaksKey) as readonly PageBreak[] | undefined;
        if (next) return withBreaks(set, tr.doc, next);
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
      },
    },
    props: {
      decorations: (state) => pageBreaksKey.getState(state),
    },
    view: () => ({
      update: (view, prevState) => {
        if (view.state.doc !== prevState.doc) onDocChanged();
      },
    }),
  });
}

export interface PageViewOptions {
  /** The page column: its top edge is the first page's, its width a page's. */
  column: () => HTMLElement | null;
  /** Elements whose size moves the note's blocks: the editor and what sits above it. */
  observed: () => Array<Element | null | undefined>;
  /** The page cards to draw (none while pages are off). */
  onPages: (pages: PageRect[]) => void;
}

export interface PageView {
  /** Pages on (the note laid out on cards) or off (one sheet, no breaks). */
  setEnabled(on: boolean): void;
  /** Lays the pages out again soon (something moved the blocks). */
  refresh(): void;
  destroy(): void;
}

/** Puts a note editor's text on pages; off until `setEnabled(true)`. */
export function attachPageView(editor: Editor, options: PageViewOptions): PageView {
  let enabled = false;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstRequestAt = 0;
  let shownPages: PageRect[] = [];
  // The last measure, for the next one to start from. Dropped whenever
  // something other than the note may have moved its blocks (the column's
  // width, what sits above the editor, a font, pages switched on).
  let measured: Measured | null = null;

  const showPages = (pages: PageRect[]): void => {
    if (samePages(pages, shownPages)) return;
    shownPages = pages;
    options.onPages(pages);
  };

  /**
   * Shows `breaks`; whether they differ from those shown. Straight to the
   * view, not through the editor's dispatch: the breaks change no text and
   * no selection, and the editor would tell every transaction listener (the
   * formatting toolbar reads its state again), which on a long note cost as
   * much as the measure.
   */
  const applyBreaks = (breaks: readonly PageBreak[]): boolean => {
    const view = editor.view;
    if (editor.isDestroyed || sameBreaks(breaks, currentPageBreaks(view.state))) return false;
    view.updateState(view.state.apply(view.state.tr.setMeta(pageBreaksKey, breaks).setMeta('addToHistory', false)));
    return true;
  };

  const measure = (): void => {
    if (destroyed || !enabled || editor.isDestroyed) return;
    const view = editor.view;
    // A transaction mid-composition would cut the IME's text short.
    if (view.composing) {
      schedule();
      return;
    }
    const column = options.column();
    const width = column?.offsetWidth ?? 0;
    if (!column || width === 0) return;
    const doc = view.state.doc;
    const last = measured !== null && measured.width === width ? measured : null;
    const blocks = measureBlocks(view, column, currentPageBreaks(view.state), last);
    if (blocks === 'unchanged' || blocks.length === 0) return;

    const style = getComputedStyle(column);
    const layout = layoutPages(blocks, {
      pageHeight: Math.round(width * PAGE_ASPECT),
      gap: PAGE_GAP,
      padTop: parseFloat(style.paddingTop) || 0,
      padBottom: parseFloat(style.paddingBottom) || 0,
    });
    const moved = applyBreaks(layout.breaks);
    showPages(layout.pages);
    // New breaks change the editor's height: the size notice that follows,
    // once they are laid out, says what it is (reading it here would lay the
    // whole note out again inside this measure).
    measured = { doc, blocks, width, height: moved ? null : view.dom.offsetHeight };
  };

  function schedule(): void {
    if (destroyed || !enabled) return;
    const { debounce, maxWait } = measureWaits(editor.state.doc.childCount);
    const now = performance.now();
    if (timer === null) firstRequestAt = now;
    else clearTimeout(timer);
    const wait = Math.max(0, Math.min(debounce, firstRequestAt + maxWait - now));
    timer = setTimeout(() => {
      timer = null;
      measure();
    }, wait);
  }

  /** Something other than the note may have moved its blocks: the next measure reads them all. */
  function scheduleAll(): void {
    measured = null;
    schedule();
  }

  editor.registerPlugin(pageBreaksPlugin(schedule));

  // The editor's size changes with what is typed (the next measure sees
  // that) and with the breaks a measure puts in. The column holds the editor,
  // so its height follows the note's; a new width makes the measure start
  // afresh. What sits above the editor moves every block.
  const editorDom = editor.view.dom;
  const resizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver((entries) => {
      const column = options.column();
      let check = false;
      for (const entry of entries) {
        if (entry.target === editorDom) {
          if (measured === null || measured.doc !== editor.state.doc) {
            check = true;
          } else if (measured.height === null) {
            // The breaks the last measure put in, now laid out.
            measured.height = editorDom.offsetHeight;
          } else if (editorDom.offsetHeight !== measured.height) {
            // Grown or shrunk with no edit (an image loaded): read every block.
            measured = null;
            check = true;
          }
        } else if (entry.target === column) {
          if (measured === null || column.offsetWidth !== measured.width) check = true;
        } else {
          measured = null;
          check = true;
        }
      }
      if (check) schedule();
    });
  for (const el of [editorDom, options.column(), ...options.observed()]) {
    if (el) resizeObserver?.observe(el);
  }
  // A web font arriving re-wraps every line.
  void document.fonts?.ready.then(() => scheduleAll());

  return {
    setEnabled(on: boolean): void {
      if (destroyed || enabled === on) return;
      enabled = on;
      measured = null;
      if (on) {
        schedule();
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = null;
      applyBreaks([]);
      showPages([]);
    },
    refresh: scheduleAll,
    destroy(): void {
      destroyed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      resizeObserver?.disconnect();
    },
  };
}
