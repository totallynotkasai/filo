/**
 * Phase C / C.10 — actionable save-error indicator.
 *
 * The toolbar's save indicator now opens a popover listing failed
 * paths + a Retry button. Two pieces of contract:
 *
 *   1. `saveStateStore.failedPaths` records the paths that failed
 *      (capped, dedup'd, newest-first) so the popover has something
 *      to render.
 *   2. A clean drain (setStatus(0, 0)) clears the path list so the
 *      popover auto-empties when retry succeeds.
 *
 * Mounting GlobalToolbar in vitest fails preprocess; this test locks
 * the store contract that the popover delegates to.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { saveStateStore } from '@renderer/stores/saveState.svelte';

beforeEach(() => {
  saveStateStore.__reset();
});

describe('saveStateStore failed-paths tracking (Phase C / C.10)', () => {
  it('starts empty', () => {
    expect(saveStateStore.failedPaths).toEqual([]);
  });

  it('noteFailedPath stores newest-first', () => {
    saveStateStore.noteFailedPath('Notes/A.md');
    saveStateStore.noteFailedPath('Notes/B.md');
    expect(saveStateStore.failedPaths).toEqual(['Notes/B.md', 'Notes/A.md']);
  });

  it('dedups: re-noting a path moves it to the front but does not duplicate', () => {
    saveStateStore.noteFailedPath('A');
    saveStateStore.noteFailedPath('B');
    saveStateStore.noteFailedPath('A');
    expect(saveStateStore.failedPaths).toEqual(['A', 'B']);
  });

  it('caps at 50 entries — oldest fall off', () => {
    for (let i = 0; i < 75; i++) {
      saveStateStore.noteFailedPath(`path/${i}`);
    }
    expect(saveStateStore.failedPaths.length).toBe(50);
    // Newest-first ordering means the most recently noted is at index 0.
    expect(saveStateStore.failedPaths[0]).toBe('path/74');
    // Oldest survivor is path/25 (75 total, 50 kept → drop the first 25).
    expect(saveStateStore.failedPaths[49]).toBe('path/25');
  });

  it('clearFailedPaths empties the list', () => {
    saveStateStore.noteFailedPath('A');
    saveStateStore.noteFailedPath('B');
    saveStateStore.clearFailedPaths();
    expect(saveStateStore.failedPaths).toEqual([]);
  });

  it('a clean drain (setStatus inflight=0,failed=0) also clears the list', () => {
    saveStateStore.noteFailedPath('Notes/A.md');
    saveStateStore.noteFailedPath('Notes/B.md');
    saveStateStore.setStatus(0, 0); // simulate a successful flush
    expect(saveStateStore.failedPaths).toEqual([]);
    expect(saveStateStore.state).toBe('saved');
  });

  it('saving (inflight>0) preserves the prior failed list', () => {
    saveStateStore.noteFailedPath('A');
    saveStateStore.setStatus(0, 1);
    saveStateStore.setStatus(1, 0); // new save started; old failure preserved
    expect(saveStateStore.failedPaths).toEqual(['A']);
    expect(saveStateStore.state).toBe('saving');
  });

  it('error state (inflight=0,failed>0) preserves the list', () => {
    saveStateStore.noteFailedPath('A');
    saveStateStore.setStatus(0, 1);
    expect(saveStateStore.state).toBe('error');
    expect(saveStateStore.failedPaths).toEqual(['A']);
  });
});
