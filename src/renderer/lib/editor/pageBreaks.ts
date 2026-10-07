/**
 * pageBreaks — the page view of a note editor in a Document tab. It measures
 * where the note's blocks lie, asks `layoutPages` where the pages break, and
 * puts each break's space above its block as a decoration. A decoration is
 * drawn, never part of the document, so the note's Markdown, its saves and
 * its undo history never see a page.
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
import { layoutPages, sameBreaks, samePages, type LaidOutBlock, type PageBreak, type PageRect } from './pageLayout';

/** The space between two page cards, px. */
export const PAGE_GAP = 24;

/** Pages keep A4's proportions at whatever width the page column has. */
const PAGE_ASPECT = Math.SQRT2;

/** Measure once edits pause, and at least this often while they don't. */
const MEASURE_DEBOUNCE_MS = 60;
const MEASURE_MAX_WAIT_MS = 250;

const pageBreaksKey = new PluginKey<DecorationSet>('filoPageBreaks');

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

interface BreakSpec {
  pageBreakShift: number;
}

interface Unit {
  pos: number;
  target: number | null;
}

function roundPx(value: number): number {
  return Math.round(value * 100) / 100;
}

function breakDecorations(doc: ProseMirrorNode, breaks: readonly PageBreak[]): DecorationSet {
  const decorations: Decoration[] = [];
  for (const { target, shift } of breaks) {
    const node = doc.nodeAt(target);
    if (!node) continue;
    const px = roundPx(shift);
    const spec: BreakSpec = { pageBreakShift: px };
    decorations.push(Decoration.node(target, target + node.nodeSize, {
      class: 'filo-page-break',
      style: `--filo-page-break: ${px}px`,
    }, spec));
  }
  return DecorationSet.create(doc, decorations);
}

/** The page breaks the editor shows now, in document order. */
export function currentPageBreaks(state: EditorState): PageBreak[] {
  const set = pageBreaksKey.getState(state);
  if (!set) return [];
  return set.find()
    .map((d) => ({ target: d.from, shift: (d.spec as BreakSpec).pageBreakShift ?? 0 }))
    .sort((a, b) => a.target - b.target);
}

/**
 * The blocks pages are laid out from, in document order: each block that
 * isn't broken into its children, with the element that takes its space (the
 * outermost element it is the first block of: a list starting with it).
 */
function collectUnits(doc: ProseMirrorNode): Unit[] {
  const units: Unit[] = [];
  const walk = (parent: ProseMirrorNode, contentStart: number, firstTarget: number | null): void => {
    parent.forEach((child, offset, index) => {
      const pos = contentStart + offset;
      const target = index === 0 ? firstTarget : pos;
      if (BREAKABLE_CONTAINERS.has(child.type.name) && child.childCount > 0) {
        walk(child, pos + 1, target);
      } else if (!NEVER_MOVED.has(child.type.name)) {
        units.push({ pos, target });
      }
    });
  };
  walk(doc, 0, null);
  return units;
}

function pageBreaksPlugin(onDocChanged: () => void): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: pageBreaksKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const next = tr.getMeta(pageBreaksKey) as readonly PageBreak[] | undefined;
        if (next) return breakDecorations(tr.doc, next);
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

  const showPages = (pages: PageRect[]): void => {
    if (samePages(pages, shownPages)) return;
    shownPages = pages;
    options.onPages(pages);
  };

  const applyBreaks = (breaks: readonly PageBreak[]): void => {
    if (editor.isDestroyed || sameBreaks(breaks, currentPageBreaks(editor.state))) return;
    editor.view.dispatch(editor.state.tr.setMeta(pageBreaksKey, breaks).setMeta('addToHistory', false));
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
    const columnRect = column.getBoundingClientRect();
    // CSS zoom (and any transform) scales the rects but not the layout.
    const scale = columnRect.width / width || 1;
    const style = getComputedStyle(column);
    const geometry = {
      pageHeight: Math.round(width * PAGE_ASPECT),
      gap: PAGE_GAP,
      padTop: parseFloat(style.paddingTop) || 0,
      padBottom: parseFloat(style.paddingBottom) || 0,
    };

    const current = currentPageBreaks(view.state);
    const blocks: LaidOutBlock[] = [];
    let next = 0;
    let above = 0;
    for (const unit of collectUnits(view.state.doc)) {
      while (next < current.length && current[next]!.target < unit.pos) above += current[next++]!.shift;
      const own = next < current.length && current[next]!.target === unit.pos ? current[next]!.shift : 0;
      const dom = view.nodeDOM(unit.pos);
      if (!(dom instanceof HTMLElement)) continue;
      const rect = dom.getBoundingClientRect();
      // Not laid out (hidden, or no layout engine at all).
      if (rect.width === 0 && rect.height === 0) continue;
      // A block's own padding moves its bottom, not its top.
      blocks.push({
        top: (rect.top - columnRect.top) / scale - above,
        bottom: (rect.bottom - columnRect.top) / scale - above - own,
        target: unit.target,
      });
    }
    if (blocks.length === 0) return;

    const layout = layoutPages(blocks, geometry);
    applyBreaks(layout.breaks);
    showPages(layout.pages);
  };

  function schedule(): void {
    if (destroyed || !enabled) return;
    const now = performance.now();
    if (timer === null) firstRequestAt = now;
    else clearTimeout(timer);
    const wait = Math.max(0, Math.min(MEASURE_DEBOUNCE_MS, firstRequestAt + MEASURE_MAX_WAIT_MS - now));
    timer = setTimeout(() => {
      timer = null;
      measure();
    }, wait);
  }

  editor.registerPlugin(pageBreaksPlugin(schedule));

  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
  for (const el of [editor.view.dom, options.column(), ...options.observed()]) {
    if (el) resizeObserver?.observe(el);
  }
  // A web font arriving re-wraps every line.
  void document.fonts?.ready.then(() => schedule());

  return {
    setEnabled(on: boolean): void {
      if (destroyed || enabled === on) return;
      enabled = on;
      if (on) {
        schedule();
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = null;
      applyBreaks([]);
      showPages([]);
    },
    refresh: schedule,
    destroy(): void {
      destroyed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      resizeObserver?.disconnect();
    },
  };
}
