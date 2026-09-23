import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTrailingDebounce } from '@renderer/lib/utils/trailingDebounce';

/**
 * M9 — the `vault:tree-updated` listener coalesces bursts through this trailing
 * debounce so a sync-storm / multi-file git op collapses to ONE tree reconcile
 * instead of a full-vault walk per event.
 */

describe('createTrailingDebounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the last trigger in a burst', () => {
    let calls = 0;
    const d = createTrailingDebounce(() => calls++, 250);

    // A burst of 5 triggers within the window.
    for (let i = 0; i < 5; i++) {
      d.trigger();
      vi.advanceTimersByTime(50); // < 250ms apart → keeps re-arming
    }
    expect(calls).toBe(0); // nothing fired yet
    expect(d.pending).toBe(true);

    vi.advanceTimersByTime(250); // quiet window elapses
    expect(calls).toBe(1); // the whole burst → ONE fire
    expect(d.pending).toBe(false);
  });

  it('fires again for a new burst after the window', () => {
    let calls = 0;
    const d = createTrailingDebounce(() => calls++, 250);

    d.trigger();
    vi.advanceTimersByTime(250);
    expect(calls).toBe(1);

    d.trigger();
    vi.advanceTimersByTime(250);
    expect(calls).toBe(2);
  });

  it('cancel() drops a pending fire (teardown safety)', () => {
    let calls = 0;
    const d = createTrailingDebounce(() => calls++, 250);

    d.trigger();
    expect(d.pending).toBe(true);
    d.cancel();
    expect(d.pending).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(calls).toBe(0); // never fired
  });

  it('cancel() is a no-op when nothing is pending', () => {
    const d = createTrailingDebounce(() => {}, 250);
    expect(() => d.cancel()).not.toThrow();
    expect(d.pending).toBe(false);
  });
});
