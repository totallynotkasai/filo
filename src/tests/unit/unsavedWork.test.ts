import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetDirtyTrackingForTests,
  beginWrite,
  endWrite,
  isUnsavedWorkEmpty,
  markPathFailed,
  registerUnsavedSource,
  unsavedWork,
} from '@renderer/lib/boards/writeStateTracking';

// One source for the file; each test sets what it reports.
let heldInMemory: string[] = [];
registerUnsavedSource(() => heldInMemory);

describe('unsavedWork — the one answer to "is anything unsaved?"', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    heldInMemory = [];
  });

  it('is empty when nothing is queued, failed, held or in flight', () => {
    const work = unsavedWork();
    expect(work).toEqual({ pending: [], failed: [], inflight: 0 });
    expect(isUnsavedWorkEmpty(work)).toBe(true);
  });

  it('a queued write is pending until it lands', () => {
    beginWrite(undefined, 'Notes/A.md');
    expect(unsavedWork().pending).toEqual(['notes/a.md']);
    expect(unsavedWork().inflight).toBe(1);
    endWrite(undefined, 'Notes/A.md', true);
    expect(isUnsavedWorkEmpty(unsavedWork())).toBe(true);
  });

  it('a failed write is failed, not pending', () => {
    beginWrite(undefined, 'A.md');
    endWrite(undefined, 'A.md', false);
    expect(unsavedWork()).toEqual({ pending: [], failed: ['a.md'], inflight: 0 });
  });

  it('a body held in memory (no write armed) counts as pending', () => {
    heldInMemory = ['Held.md'];
    expect(unsavedWork().pending).toEqual(['held.md']);
    expect(isUnsavedWorkEmpty(unsavedWork())).toBe(false);
  });

  it('a path that failed and is also held is listed once, as failed', () => {
    markPathFailed(undefined, 'Both.md');
    heldInMemory = ['Both.md'];
    expect(unsavedWork()).toEqual({ pending: [], failed: ['both.md'], inflight: 0 });
  });

  it('a write in flight with no path still counts', () => {
    beginWrite(undefined);
    const work = unsavedWork();
    expect(work.pending).toEqual([]);
    expect(isUnsavedWorkEmpty(work)).toBe(false);
  });
});
