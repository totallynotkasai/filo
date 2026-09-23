import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveStateStore } from '@renderer/stores/saveState.svelte';

describe('saveStateStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveStateStore.__reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in idle', () => {
    expect(saveStateStore.state).toBe('idle');
  });

  it('transitions to saving when inflight > 0', () => {
    saveStateStore.setStatus(1, 0);
    expect(saveStateStore.state).toBe('saving');
  });

  it('transitions to saved when a clean drain completes', () => {
    saveStateStore.setStatus(1, 0);
    saveStateStore.setStatus(0, 0);
    expect(saveStateStore.state).toBe('saved');
  });

  it('saved decays to idle after 2s', () => {
    saveStateStore.setStatus(0, 0);
    expect(saveStateStore.state).toBe('saved');
    vi.advanceTimersByTime(2000);
    expect(saveStateStore.state).toBe('idle');
  });

  it('error state is sticky until a clean drain — even while a new write is inflight (L1)', () => {
    saveStateStore.setStatus(0, 1);
    expect(saveStateStore.state).toBe('error');
    // Audit-7 L1 — a new inflight write while a failure is outstanding now
    // reads 'error' (failed outranks saving), not the old perpetual 'saving'.
    // This is the wedged-then-timed-out write case: inflight held, path failed.
    saveStateStore.setStatus(1, 1);
    expect(saveStateStore.state).toBe('error');
    // Drain still has a failed path → stays in error
    saveStateStore.setStatus(0, 1);
    expect(saveStateStore.state).toBe('error');
    // Finally a clean drain
    saveStateStore.setStatus(0, 0);
    expect(saveStateStore.state).toBe('saved');
  });

  it('a wedged-then-failed write (inflight AND failed) reads error, not saving (L1)', () => {
    // The gateway's writeTimeoutMs fired: markPathFailed bumped `failed` while
    // trackComponentWrite still holds the inflight increment (IPC never settled).
    saveStateStore.setStatus(1, 1);
    expect(saveStateStore.state).toBe('error');
  });

  it('cancels the saved-decay timer if a new write starts mid-window', () => {
    saveStateStore.setStatus(0, 0);
    expect(saveStateStore.state).toBe('saved');
    vi.advanceTimersByTime(1000);
    saveStateStore.setStatus(1, 0);
    expect(saveStateStore.state).toBe('saving');
    // After another 2000ms, the old saved-decay timer should not flip us
    // back to idle while we are mid-save.
    vi.advanceTimersByTime(2000);
    expect(saveStateStore.state).toBe('saving');
  });
});
