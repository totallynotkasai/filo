import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackDocumentScroll } from '@renderer/lib/editor/documentScroll';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';

/** A scroller whose height grows as the note loads: scrollTop clamps to it. */
function scroller(): { el: HTMLElement; setMax: (max: number) => void } {
  const el = document.createElement('div');
  let max = 0;
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(v, max)); },
  });
  return { el, setMax: (m) => { max = m; } };
}

function scrollTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
  el.dispatchEvent(new Event('scroll'));
}

describe('a Document tab coming back', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetDirtyTrackingForTests();
  });

  it('starts at the top the first time', () => {
    const { el, setMax } = scroller();
    setMax(5000);
    const stop = trackDocumentScroll(el, 'tab-a');
    expect(el.scrollTop).toBe(0);
    stop();
  });

  it('returns where the user left off, once the note has grown tall enough', () => {
    const first = scroller();
    first.setMax(5000);
    const stopFirst = trackDocumentScroll(first.el, 'tab-a');
    scrollTo(first.el, 1800);
    stopFirst();

    const again = scroller();
    const stop = trackDocumentScroll(again.el, 'tab-a');
    expect(again.el.scrollTop).toBe(0); // nothing loaded yet
    again.setMax(5000);
    vi.advanceTimersByTime(50);
    expect(again.el.scrollTop).toBe(1800);
    stop();
  });

  it("keeps each tab's place apart", () => {
    const a = scroller();
    a.setMax(5000);
    const stopA = trackDocumentScroll(a.el, 'tab-a');
    scrollTo(a.el, 900);
    stopA();
    const b = scroller();
    b.setMax(5000);
    const stopB = trackDocumentScroll(b.el, 'tab-b');
    vi.advanceTimersByTime(50);
    expect(b.el.scrollTop).toBe(0);
    stopB();
  });

  it('lets the user scroll away while it restores, and keeps the old place if they leave before the note loads', () => {
    const first = scroller();
    first.setMax(5000);
    const stopFirst = trackDocumentScroll(first.el, 'tab-a');
    scrollTo(first.el, 1200);
    stopFirst();

    // Left again before the note loaded: the clamped 0 isn't recorded.
    const early = scroller();
    const stopEarly = trackDocumentScroll(early.el, 'tab-a');
    early.el.dispatchEvent(new Event('scroll'));
    stopEarly();

    const again = scroller();
    again.setMax(5000);
    const stop = trackDocumentScroll(again.el, 'tab-a');
    expect(again.el.scrollTop).toBe(1200);
    again.el.dispatchEvent(new Event('wheel'));
    scrollTo(again.el, 300);
    vi.advanceTimersByTime(100);
    expect(again.el.scrollTop).toBe(300);
    stop();

    const last = scroller();
    last.setMax(5000);
    const stopLast = trackDocumentScroll(last.el, 'tab-a');
    expect(last.el.scrollTop).toBe(300);
    stopLast();
  });
});
