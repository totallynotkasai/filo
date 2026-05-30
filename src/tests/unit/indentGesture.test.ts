import { describe, it, expect, afterEach } from 'vitest';
import {
  INDENT_THRESHOLD_PX,
  isHorizontalIndentGesture,
  createIndentTracker,
} from '@renderer/lib/tasklist/indentGesture';

/**
 * Phase 6 — indent/outdent gesture classification.
 *
 * Two surface areas:
 *   1. `isHorizontalIndentGesture(dx, dy)` — pure threshold/ratio test.
 *   2. `createIndentTracker()` — installs a window pointermove listener that
 *      captures the live (clientX, clientY, [data-task-id]) and exposes a
 *      `classify()` returning the gesture kind.
 */

describe('isHorizontalIndentGesture — table-driven classification', () => {
  it.each<[number, number, boolean, string]>([
    // [dx, dy, expected, label]
    [0, 0, false, 'no movement'],
    [10, 0, false, 'tiny horizontal under threshold'],
    [-10, 0, false, 'tiny horizontal under threshold (negative)'],
    [INDENT_THRESHOLD_PX, 0, false, 'exactly at threshold — must exceed'],
    [INDENT_THRESHOLD_PX + 1, 0, true, 'horizontal just past threshold'],
    [-(INDENT_THRESHOLD_PX + 1), 0, true, 'leftward past threshold'],
    [80, 80, false, 'diagonal — horizontal ≠ dominant (ratio 1:1)'],
    [80, 30, true, 'mostly horizontal, mild vertical drift'],
    [80, 60, false, 'horizontal not dominant enough (1.33× < 1.5×)'],
    [80, 55, false, '80 vs 55: ratio 1.45× — still under 1.5×'],
    [120, 50, true, 'horizontal dominates by ≥1.5×'],
    [-120, 40, true, 'leftward + horizontal-dominant'],
    [50, 200, false, 'mostly vertical — clear reorder'],
    [INDENT_THRESHOLD_PX + 1, 30, true, 'just past threshold + mild vertical'],
  ])('dx=%i dy=%i → %s (%s)', (dx, dy, expected) => {
    expect(isHorizontalIndentGesture(dx, dy)).toBe(expected);
  });

  it('threshold constant is exactly 60px', () => {
    expect(INDENT_THRESHOLD_PX).toBe(60);
  });
});

describe('createIndentTracker — lifecycle', () => {
  afterEach(() => {
    // Defensive: a leaked listener between tests would corrupt state.
    document.body.innerHTML = '';
  });

  it('classify() before install returns "none" with null target', () => {
    const t = createIndentTracker();
    expect(t.classify()).toEqual({ kind: 'none', targetTileId: null });
  });

  it('install + uninstall are idempotent (double-call is safe)', () => {
    const t = createIndentTracker();
    t.install(0, 0);
    t.install(50, 50); // second install is a no-op — first start coords win
    t.uninstall();
    t.uninstall(); // second uninstall is a no-op
    expect(() => t.classify()).not.toThrow();
  });

  it('captures last pointer position via window pointermove', () => {
    const t = createIndentTracker();
    t.install(0, 0);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 5 }));
    const c = t.classify();
    expect(c.kind).toBe('indent');
    t.uninstall();
  });

  it('classifies rightward dominant motion as "indent"', () => {
    const t = createIndentTracker();
    t.install(10, 10);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 15 }));
    const c = t.classify();
    expect(c.kind).toBe('indent');
    t.uninstall();
  });

  it('classifies leftward dominant motion as "outdent"', () => {
    const t = createIndentTracker();
    t.install(100, 10);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 15 }));
    const c = t.classify();
    expect(c.kind).toBe('outdent');
    t.uninstall();
  });

  it('classifies mostly-vertical motion as "none" (reorder)', () => {
    const t = createIndentTracker();
    t.install(10, 10);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 15, clientY: 200 }));
    const c = t.classify();
    expect(c.kind).toBe('none');
    t.uninstall();
  });

  it('walks up the DOM to find [data-task-id] on a child node', () => {
    const wrap = document.createElement('div');
    wrap.dataset.taskId = 'tile_123';
    const child = document.createElement('span');
    child.className = 'task-item-label';
    wrap.appendChild(child);
    document.body.appendChild(wrap);

    const t = createIndentTracker();
    t.install(0, 0);
    // Synthesize a pointermove whose target is the child span.
    const evt = new PointerEvent('pointermove', {
      clientX: 100,
      clientY: 5,
      bubbles: true,
    });
    Object.defineProperty(evt, 'target', { value: child });
    window.dispatchEvent(evt);

    const c = t.classify();
    expect(c.targetTileId).toBe('tile_123');
    expect(c.kind).toBe('indent');
    t.uninstall();
  });

  it('targetTileId is null when pointer is not over a [data-task-id] subtree', () => {
    const stray = document.createElement('div');
    document.body.appendChild(stray);

    const t = createIndentTracker();
    t.install(0, 0);
    const evt = new PointerEvent('pointermove', { clientX: 100, clientY: 5, bubbles: true });
    Object.defineProperty(evt, 'target', { value: stray });
    window.dispatchEvent(evt);

    expect(t.classify().targetTileId).toBeNull();
    t.uninstall();
  });

  it('uninstall removes the listener — later moves do not update lastTarget', () => {
    const wrap1 = document.createElement('div');
    wrap1.dataset.taskId = 'first';
    document.body.appendChild(wrap1);

    const t = createIndentTracker();
    t.install(0, 0);
    const evt1 = new PointerEvent('pointermove', { clientX: 100, clientY: 5, bubbles: true });
    Object.defineProperty(evt1, 'target', { value: wrap1 });
    window.dispatchEvent(evt1);

    expect(t.classify().targetTileId).toBe('first');

    t.uninstall();

    // After uninstall, classify() returns the captured state — but new
    // pointermoves must NOT mutate it (listener is removed).
    const wrap2 = document.createElement('div');
    wrap2.dataset.taskId = 'second';
    document.body.appendChild(wrap2);
    const evt2 = new PointerEvent('pointermove', { clientX: 999, clientY: 999, bubbles: true });
    Object.defineProperty(evt2, 'target', { value: wrap2 });
    window.dispatchEvent(evt2);

    // The tracker resets lastTargetTileId to null on uninstall, so classify
    // here is independent of the second event.
    expect(t.classify().targetTileId).toBeNull();
  });

  it('a re-installed tracker resets the captured target', () => {
    const wrap = document.createElement('div');
    wrap.dataset.taskId = 'first';
    document.body.appendChild(wrap);

    const t = createIndentTracker();
    t.install(0, 0);
    const evt = new PointerEvent('pointermove', { clientX: 100, clientY: 5, bubbles: true });
    Object.defineProperty(evt, 'target', { value: wrap });
    window.dispatchEvent(evt);
    expect(t.classify().targetTileId).toBe('first');

    t.uninstall();
    t.install(0, 0);
    // Re-installed without a new pointermove — captured target is clean.
    expect(t.classify().targetTileId).toBeNull();
    t.uninstall();
  });
});
