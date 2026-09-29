import { describe, it, expect, afterEach, vi } from 'vitest';
import { clockStore } from '@renderer/stores/clock.svelte';

/**
 * The Task List's Today / Overdue lists read the clock store's day, which
 * moves on at local midnight, and again when the window wakes (a timer can
 * fire late after the machine sleeps).
 */

function midnight(y: number, m: number, d: number): number {
  return new Date(y, m, d, 0, 0, 0, 0).getTime();
}

afterEach(() => {
  clockStore.stop();
  vi.useRealTimers();
});

describe('clockStore', () => {
  it('moves on to the next day at local midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 29, 23, 58));
    clockStore.stop();
    expect(clockStore.today).toBe(midnight(2026, 8, 29));

    vi.advanceTimersByTime(3 * 60_000);
    expect(clockStore.today).toBe(midnight(2026, 8, 30));
    expect(clockStore.todayDate().getHours()).toBe(0);
  });

  it('catches up when the window gets focus after a sleep', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 29, 22, 0));
    clockStore.stop();
    expect(clockStore.today).toBe(midnight(2026, 8, 29));

    // The machine slept through midnight: the wall clock jumped, no timer ran.
    vi.setSystemTime(new Date(2026, 8, 30, 8, 0));
    window.dispatchEvent(new Event('focus'));
    expect(clockStore.today).toBe(midnight(2026, 8, 30));
  });
});
