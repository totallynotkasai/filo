/**
 * `flushAll()` must pre-drain an older in-flight write for a key
 * BEFORE firing that key's pending (newest) write, so the newest lands LAST.
 *
 * The fix that drains a key's prior in-flight write before firing the
 * pending one existed only in `flush(key)`. `flushAll()` fired all drained-pending
 * writes and then awaited the already-in-flight ones concurrently. For a
 * NON-serialized scheduler (board / config / misc — markdown / frontmatter
 * serialize per path) the older in-flight write and the newer pending write were
 * both in flight at once; on a slow OneDrive/SMB volume the OS could land the
 * stale write last and clobber the newer `.board.json`/config payload.
 *
 * These tests drive the `createScheduler` primitive directly: enqueue a slow
 * write A, re-arm a pending write B for the SAME key, call `flushAll()`, and
 * assert B's `performWrite` does not even START until A has resolved (B last).
 * Bite-verify: revert the `flushAll` pre-drain → the "B waits for A" assertion
 * goes red (B fires concurrently).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createScheduler, disposeTestSchedulers } from '../helpers/testSchedulers';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { restoreFiloDefault } from '../helpers/filoBridge';

// Retire every scheduler a test made, so nothing it left armed reaches the next test.
afterEach(disposeTestSchedulers);

interface TArgs {
  vaultRoot: string;
  path: string;
}

function makeArgs(path = 'note.md', vaultRoot = '/vault'): TArgs {
  return { vaultRoot, path };
}

describe('createScheduler — flushAll per-key pre-drain', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    vi.useRealTimers();
  });

  it('drains the older in-flight write before firing the newer pending write (B lands last)', async () => {
    const started: string[] = [];
    const finished: string[] = [];

    let resolveA!: () => void;
    const ipcA = new Promise<void>((res) => {
      resolveA = res;
    });
    let fireIndex = 0;

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: async () => {
        const label = fireIndex === 0 ? 'A' : 'B';
        fireIndex++;
        started.push(label);
        // A is the slow, already-in-flight write; B must not start until A
        // settles. B resolves immediately once it is finally allowed to fire.
        if (label === 'A') await ipcA;
        finished.push(label);
      },
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    vi.useFakeTimers();
    scheduler.schedule('k1', () => makeArgs()); // arm A
    vi.advanceTimersByTime(200); // timer fires → write A starts, awaits ipcA (in flight)
    scheduler.schedule('k1', () => makeArgs()); // re-arm pending B (NOT fired yet)
    vi.useRealTimers();

    // A is in flight; B has only been armed.
    expect(started).toEqual(['A']);

    const flushPromise = scheduler.flushAll();

    // The pre-drain awaits A before firing B: B must NOT have started even after
    // several microtask ticks, and A must not have finished (still awaiting ipcA).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['A']); // ← regresses to ['A','B'] without the pre-drain
    expect(finished).toEqual([]);

    // Resolve A → the pre-drain completes → B is finally fired.
    resolveA();
    const result = await flushPromise;

    // B started only after A finished, and resolved last.
    expect(started).toEqual(['A', 'B']);
    expect(finished).toEqual(['A', 'B']);
    expect(result.failed).toEqual([]);
  });

  it('still drains a key that has ONLY an in-flight write (no pending) — no regression', async () => {
    // Guards the "keep the existing inflightSnapshot await afterward" half of the
    // fix: a key with an in-flight write but no re-armed pending must still be
    // awaited + attributed by flushAll.
    const finished: string[] = [];
    let resolveA!: () => void;
    const ipcA = new Promise<void>((res) => {
      resolveA = res;
    });

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: async () => {
        await ipcA;
        finished.push('A');
      },
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    vi.useFakeTimers();
    scheduler.schedule('k1', () => makeArgs());
    vi.advanceTimersByTime(200); // A in flight; no re-arm
    vi.useRealTimers();

    const flushPromise = scheduler.flushAll();
    await Promise.resolve();
    expect(finished).toEqual([]); // flushAll blocks on the in-flight write

    resolveA();
    const result = await flushPromise;
    expect(finished).toEqual(['A']);
    expect(result.failed).toEqual([]);
  });
});
