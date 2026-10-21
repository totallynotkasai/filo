/**
 * Where each Document tab was scrolled to, for this session. A pane remounts
 * its board on every tab switch, so without this a note came back at its top.
 * Kept by tab id (a rename keeps the tab), dropped on a vault swap.
 */

import { registerResetCallback, registerTestResetCallback } from '../boards/writeStateTracking';

// allow-module-state: cleared via registerResetCallback below (fires on vault swap and per-test)
const scrollByTab = new Map<string, number>();

registerResetCallback(() => scrollByTab.clear());
registerTestResetCallback(() => scrollByTab.clear());

/** The longest the note stays hidden waiting for its layout (a very long note measures late). */
const RESTORE_WINDOW_MS = 1500;
const USER_SCROLL_EVENTS = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;

export interface DocumentScrollOptions {
  /** What is hidden until the note is back in place: the note, not the board's background. */
  content: HTMLElement;
  /** The note's pages are still to be laid out: wait for `laidOut()` before showing it. */
  awaitLayout: boolean;
}

export interface DocumentScrollTracking {
  /** The page view has placed its breaks: the saved offset now shows what it showed. */
  laidOut(): void;
  stop(): void;
}

/**
 * Scrolls `el` back to where tab `tabId` was left, then records where it is
 * scrolled to. The note arrives after the mount, and its page breaks (which
 * push every block down) after that, so the saved offset would show the top,
 * then the wrong lines, then the right ones. Instead the note stays hidden,
 * the offset set each frame, until it is laid out and the offset reached;
 * then it shows, already in place. The user scrolling, clicking or typing
 * shows it at once (their move wins), and so does the time running out.
 * Nothing is recorded meanwhile, so a switch away before the note has loaded
 * keeps the old position.
 */
export function trackDocumentScroll(el: HTMLElement, tabId: string, options: DocumentScrollOptions): DocumentScrollTracking {
  const target = scrollByTab.get(tabId) ?? 0;
  let restoring = target > 0;
  let layoutReady = !options.awaitLayout;
  let frame = 0;
  const started = performance.now();

  const endRestore = (): void => {
    if (!restoring) return;
    restoring = false;
    cancelAnimationFrame(frame);
    options.content.style.visibility = '';
    for (const type of USER_SCROLL_EVENTS) el.removeEventListener(type, endRestore, true);
  };
  const step = (): void => {
    el.scrollTop = target;
    const inPlace = layoutReady && Math.abs(el.scrollTop - target) < 1;
    if (inPlace || performance.now() - started > RESTORE_WINDOW_MS) endRestore();
    else frame = requestAnimationFrame(step);
  };
  const record = (): void => {
    if (restoring) return;
    if (el.scrollTop > 0) scrollByTab.set(tabId, el.scrollTop);
    else scrollByTab.delete(tabId);
  };

  el.addEventListener('scroll', record, { passive: true });
  if (restoring) {
    options.content.style.visibility = 'hidden';
    for (const type of USER_SCROLL_EVENTS) el.addEventListener(type, endRestore, { capture: true, passive: true });
    step();
  }
  return {
    laidOut(): void {
      if (layoutReady || !restoring) return;
      layoutReady = true;
      // Straight away, before the frame paints the breaks at the old offset.
      cancelAnimationFrame(frame);
      step();
    },
    stop(): void {
      endRestore();
      el.removeEventListener('scroll', record);
    },
  };
}
