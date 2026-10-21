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

/** How long a restore keeps re-applying while the note loads and its pages are laid out. */
const RESTORE_WINDOW_MS = 1500;
const USER_SCROLL_EVENTS = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;

/**
 * Scrolls `el` back to where tab `tabId` was left, then records where it is
 * scrolled to. The note's text and its page breaks arrive after the mount,
 * so the old position is set again each frame for a moment, until the user
 * scrolls, clicks or types (their move wins). Nothing is recorded meanwhile,
 * so a switch away before the note has loaded keeps the old position.
 * Returns a function that stops both.
 */
export function trackDocumentScroll(el: HTMLElement, tabId: string): () => void {
  const target = scrollByTab.get(tabId) ?? 0;
  let restoring = target > 0;
  let frame = 0;
  const started = performance.now();

  const endRestore = (): void => {
    if (!restoring) return;
    restoring = false;
    cancelAnimationFrame(frame);
    for (const type of USER_SCROLL_EVENTS) el.removeEventListener(type, endRestore, true);
  };
  const step = (): void => {
    el.scrollTop = target;
    if (performance.now() - started > RESTORE_WINDOW_MS) endRestore();
    else frame = requestAnimationFrame(step);
  };
  const record = (): void => {
    if (restoring) return;
    if (el.scrollTop > 0) scrollByTab.set(tabId, el.scrollTop);
    else scrollByTab.delete(tabId);
  };

  el.addEventListener('scroll', record, { passive: true });
  if (restoring) {
    for (const type of USER_SCROLL_EVENTS) el.addEventListener(type, endRestore, { capture: true, passive: true });
    step();
  }
  return () => {
    endRestore();
    el.removeEventListener('scroll', record);
  };
}
