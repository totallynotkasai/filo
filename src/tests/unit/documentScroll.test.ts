import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackDocumentScroll, type DocumentScrollTracking } from '@renderer/lib/editor/documentScroll';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';

/** A scroller whose height grows as the note loads: scrollTop clamps to it. */
function scroller(): { el: HTMLElement; content: HTMLElement; setMax: (max: number) => void } {
  const el = document.createElement('div');
  const content = document.createElement('div');
  el.append(content);
  let max = 0;
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(v, max)); },
  });
  return { el, content, setMax: (m) => { max = m; } };
}

function scrollTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
  el.dispatchEvent(new Event('scroll'));
}

/** Leaves tab `tabId` scrolled to `top`. */
function leaveAt(tabId: string, top: number): void {
  const s = scroller();
  s.setMax(5000);
  const tracking = trackDocumentScroll(s.el, tabId, { content: s.content, awaitLayout: false });
  scrollTo(s.el, top);
  tracking.stop();
}

const hidden = (content: HTMLElement): boolean => content.style.visibility === 'hidden';

describe('a Document tab coming back', () => {
  let tracking: DocumentScrollTracking | null = null;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  });
  afterEach(() => {
    tracking?.stop();
    tracking = null;
    vi.useRealTimers();
    __resetDirtyTrackingForTests();
  });

  it('starts at the top the first time, shown at once', () => {
    const s = scroller();
    s.setMax(5000);
    tracking = trackDocumentScroll(s.el, 'tab-a', { content: s.content, awaitLayout: true });
    expect(s.el.scrollTop).toBe(0);
    expect(hidden(s.content)).toBe(false);
  });

  it('shows the note only once it has grown tall enough to be back in place', () => {
    leaveAt('tab-a', 1800);
    const s = scroller();
    tracking = trackDocumentScroll(s.el, 'tab-a', { content: s.content, awaitLayout: false });
    expect(hidden(s.content)).toBe(true); // nothing loaded yet: it would show the top
    s.setMax(5000);
    vi.advanceTimersByTime(20);
    expect(s.el.scrollTop).toBe(1800);
    expect(hidden(s.content)).toBe(false);
  });

  it("waits for the pages, which move every line, before showing the note", () => {
    leaveAt('tab-a', 1800);
    const s = scroller();
    s.setMax(5000);
    tracking = trackDocumentScroll(s.el, 'tab-a', { content: s.content, awaitLayout: true });
    vi.advanceTimersByTime(100);
    expect(s.el.scrollTop).toBe(1800);
    expect(hidden(s.content)).toBe(true);
    tracking.laidOut();
    expect(hidden(s.content)).toBe(false);
  });

  it('shows the note when the layout never comes', () => {
    leaveAt('tab-a', 1800);
    const s = scroller();
    s.setMax(5000);
    tracking = trackDocumentScroll(s.el, 'tab-a', { content: s.content, awaitLayout: true });
    vi.advanceTimersByTime(2000);
    expect(hidden(s.content)).toBe(false);
  });

  it("keeps each tab's place apart", () => {
    leaveAt('tab-a', 900);
    const s = scroller();
    s.setMax(5000);
    tracking = trackDocumentScroll(s.el, 'tab-b', { content: s.content, awaitLayout: false });
    vi.advanceTimersByTime(50);
    expect(s.el.scrollTop).toBe(0);
  });

  it('lets the user scroll away while it restores, and keeps the old place if they leave before the note loads', () => {
    leaveAt('tab-a', 1200);

    // Left again before the note loaded: the clamped 0 isn't recorded.
    const early = scroller();
    const earlyTracking = trackDocumentScroll(early.el, 'tab-a', { content: early.content, awaitLayout: true });
    early.el.dispatchEvent(new Event('scroll'));
    earlyTracking.stop();
    expect(hidden(early.content)).toBe(false);

    const again = scroller();
    again.setMax(5000);
    tracking = trackDocumentScroll(again.el, 'tab-a', { content: again.content, awaitLayout: true });
    expect(again.el.scrollTop).toBe(1200);
    again.el.dispatchEvent(new Event('wheel'));
    expect(hidden(again.content)).toBe(false);
    scrollTo(again.el, 300);
    vi.advanceTimersByTime(100);
    expect(again.el.scrollTop).toBe(300);
    tracking.stop();

    const last = scroller();
    last.setMax(5000);
    tracking = trackDocumentScroll(last.el, 'tab-a', { content: last.content, awaitLayout: false });
    expect(last.el.scrollTop).toBe(300);
  });
});
