/**
 * pageLayout — where a note's pages break in a Document tab's page view.
 *
 * Pure: given the note's blocks as they lie with no breaks, it says which
 * block starts each new page, how far down it moves, and where every page
 * card is drawn. The pages are only drawn (`pageBreaks.ts` adds the space,
 * the Document tab the cards): nothing here reaches the note or its file.
 *
 * A block is never split. One taller than a page's text area, or one that
 * nothing can move (the note's first block), stretches its page to hold it
 * instead of running into the gap below (KNOWN_LIMITATIONS #53).
 */

export interface PageGeometry {
  /** A page card's height, px. */
  pageHeight: number;
  /** The space between two cards, px. */
  gap: number;
  /** The empty band at a page's top and bottom, px. */
  padTop: number;
  padBottom: number;
}

/**
 * One block as laid out with no page breaks: px from the first page's top
 * edge. `target` is the document position of the element that takes the
 * space when this block starts a page: the block itself, or the outermost
 * element it opens (a list it is the first item of), so the space goes above
 * that element's start. Null when nothing above the block can move it.
 */
export interface LaidOutBlock {
  top: number;
  bottom: number;
  target: number | null;
}

export interface PageRect {
  top: number;
  height: number;
}

/** The space put above the element at `target` to start a page with it. */
export interface PageBreak {
  target: number;
  shift: number;
}

export interface PageLayout {
  pages: PageRect[];
  breaks: PageBreak[];
}

/** Sub-pixel differences in measuring don't move a block to another page. */
const EPSILON = 0.5;

/** A page needs some room for text, or every block would stretch its own page. */
const MIN_TEXT_AREA = 40;

/**
 * Pages for `blocks`, which come in document order. Each block that would
 * cross its page's bottom band starts the next page, unless it is taller
 * than a page's text area or can't move, when its page grows to hold it.
 */
export function layoutPages(blocks: readonly LaidOutBlock[], geometry: PageGeometry): PageLayout {
  const { pageHeight, gap, padTop, padBottom } = geometry;
  const textArea = pageHeight - padTop - padBottom;
  const pages: PageRect[] = [{ top: 0, height: pageHeight }];
  const breaks: PageBreak[] = [];
  let shift = 0;

  for (const block of blocks) {
    let page = pages[pages.length - 1]!;
    const top = block.top + shift;
    const bottom = block.bottom + shift;
    if (bottom <= page.top + page.height - padBottom + EPSILON) continue;

    const startsPage = top <= page.top + padTop + EPSILON;
    const fits = textArea >= MIN_TEXT_AREA && bottom - top <= textArea + EPSILON;
    if (startsPage || !fits || block.target === null) {
      page.height = Math.max(page.height, bottom + padBottom - page.top);
      continue;
    }

    page = { top: page.top + page.height + gap, height: pageHeight };
    pages.push(page);
    const delta = page.top + padTop - top;
    breaks.push({ target: block.target, shift: delta });
    shift += delta;
  }

  return { pages, breaks };
}

/** Whether two sets of breaks put the same space in the same places. */
export function sameBreaks(a: readonly PageBreak[], b: readonly PageBreak[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.target === b[i]!.target && Math.abs(x.shift - b[i]!.shift) < EPSILON);
}

/** Whether two page lists draw the same cards. */
export function samePages(a: readonly PageRect[], b: readonly PageRect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => Math.abs(x.top - b[i]!.top) < EPSILON && Math.abs(x.height - b[i]!.height) < EPSILON);
}
