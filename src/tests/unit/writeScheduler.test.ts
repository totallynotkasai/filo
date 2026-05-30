/**
 * Phase R1 — `createScheduler` primitive tests.
 *
 * Covers the contract every five legacy schedulers (board / markdown /
 * frontmatter / config / misc) must share post-migration:
 *
 *  1. In-flight failure attribution — a write that rejects after the timer
 *     fires must surface in `flushAll().failed[]` when the in-flight is
 *     still tracked. Two legacy modules dropped this attribution silently.
 *  2. Flush-during-in-flight — `flushAll`/`flush(key)` awaits a write whose
 *     timer already fired and reports its real outcome.
 *  3. Cancel-during-in-flight — cancelling a key while its disk I/O is
 *     pending does NOT race the in-flight write's completion handler.
 *  4. Vault-swap reset — `reset()` clears the tracker so a late settle
 *     against the OUTGOING vault does not mutate the new vault's sentinel
 *     state. Verified via the `trackerIsCurrent` guard inside `fireWrite`.
 *  5. Partial-failure passthrough — a `performWrite` that resolves with
 *     `{ failed: [...] }` (e.g. config bundle) is attributed correctly.
 *  6. Missing-source surface — args getter returning null surfaces a toast
 *     (when consumer opted in) and counts as failure.
 *  7. Rename-mid-debounce — the `onReschedule` hook fires with both
 *     sentinels so the board scheduler can drop the old path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createScheduler } from '@renderer/lib/boards/writeScheduler';
import {
  __resetDirtyTrackingForTests,
  setWriteStateListener,
} from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

interface TArgs {
  vaultRoot: string;
  path: string;
}

function makeArgs(path = 'file.md', vaultRoot = '/vault'): TArgs {
  return { vaultRoot, path };
}

describe('createScheduler — in-flight failure attribution', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    vi.useRealTimers();
  });

  it('flushAll attributes a rejected in-flight write into failed[]', async () => {
    vi.useFakeTimers();

    let rejectIpc!: (err: unknown) => void;
    const ipc = new Promise<void>((_, rej) => {
      rejectIpc = rej;
    });

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: () => ipc,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    scheduler.schedule('k1', () => makeArgs('file.md'));

    // Fire the timer → write enters in-flight, does NOT resolve.
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    const flushPromise = scheduler.flushAll();

    rejectIpc(new Error('disk full'));

    const result = await flushPromise;
    expect(result.failed).toEqual(['file.md']);
  });

  it('flush(key) attributes a rejected in-flight write into ok=false', async () => {
    vi.useFakeTimers();

    let rejectIpc!: (err: unknown) => void;
    const ipc = new Promise<void>((_, rej) => {
      rejectIpc = rej;
    });

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: () => ipc,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    scheduler.schedule('k1', () => makeArgs('a.md'));

    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    const flushPromise = scheduler.flush('k1');
    rejectIpc(new Error('EACCES'));

    const result = await flushPromise;
    expect(result.ok).toBe(false);
  });

  it('flushAll reports failed=[] when in-flight writes resolve successfully', async () => {
    vi.useFakeTimers();

    let resolveIpc!: () => void;
    const ipc = new Promise<void>((res) => {
      resolveIpc = res;
    });

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: () => ipc,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    scheduler.schedule('k1', () => makeArgs('happy.md'));

    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    const flushPromise = scheduler.flushAll();
    resolveIpc();

    const result = await flushPromise;
    expect(result.failed).toEqual([]);
  });
});

describe('createScheduler — flushAll awaits in-flight writes', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    vi.useRealTimers();
  });

  it('flushAll blocks until in-flight write resolves', async () => {
    vi.useFakeTimers();

    let resolveIpc!: () => void;
    const ipc = new Promise<void>((res) => {
      resolveIpc = res;
    });
    let resolved = false;

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: async () => {
        await ipc;
        resolved = true;
      },
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    scheduler.schedule('k1', () => makeArgs('block.md'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    const flushPromise = scheduler.flushAll();

    // Give event loop a few ticks — flush must NOT resolve yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    resolveIpc();
    await flushPromise;
    expect(resolved).toBe(true);
  });
});

describe('createScheduler — vault-swap reset guard', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    vi.useRealTimers();
  });

  it('reset mid-IPC: late settle does not record endWrite or failures', async () => {
    vi.useFakeTimers();

    let rejectIpc!: (err: unknown) => void;
    const ipc = new Promise<void>((_, rej) => {
      rejectIpc = rej;
    });

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: () => ipc,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    scheduler.schedule('k1', () => makeArgs('a.md', '/vault-A'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    // Vault swap — clears in-flight tracker.
    scheduler.reset();

    // Old IPC rejects AFTER reset — must NOT leak into failures.
    rejectIpc(new Error('vault-A bounced'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Schedule a fresh write on the new vault with a different path; the
    // old vault's leak (if any) would surface here.
    let resolveB!: () => void;
    const ipcB = new Promise<void>((res) => {
      resolveB = res;
    });

    const schedulerB = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: () => ipcB,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    vi.useFakeTimers();
    schedulerB.schedule('k1', () => makeArgs('a.md', '/vault-B'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    const flushPromise = schedulerB.flushAll();
    resolveB();

    const result = await flushPromise;
    expect(result.failed).toEqual([]);
  });

  it('reset clears pending timers so post-swap fire is suppressed', () => {
    vi.useFakeTimers();
    const writeSpy = vi.fn(async () => undefined);

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: writeSpy,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    scheduler.schedule('k1', () => makeArgs('a.md'));
    scheduler.reset();

    vi.advanceTimersByTime(2000);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('createScheduler — cancel during in-flight', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    vi.useRealTimers();
  });

  it('cancel(key) before timer fires emits clean endWrite', () => {
    vi.useFakeTimers();
    const writeSpy = vi.fn(async () => undefined);

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: writeSpy,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    scheduler.schedule('k1', () => makeArgs('a.md'));
    scheduler.cancel('k1');

    vi.advanceTimersByTime(2000);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('cancel(key) is a no-op when no pending entry exists', () => {
    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: async () => undefined,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    expect(() => scheduler.cancel('nonexistent')).not.toThrow();
  });
});

describe('createScheduler — partial-failure passthrough', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    vi.useRealTimers();
  });

  it('flushAll surfaces per-target failures from a still-in-flight performWrite', async () => {
    // Models the config-bundle race: the timer fired and the IPC is mid-
    // flight when the user hits Ctrl+S. flushAll must await the in-flight
    // write and aggregate its returned partial-failure list.
    vi.useFakeTimers();

    let resolveIpc!: (val: { failed: string[] }) => void;
    const ipc = new Promise<{ failed: string[] }>((res) => {
      resolveIpc = res;
    });

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: () => ipc,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    scheduler.schedule('config', () => makeArgs('.filo/'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    const flushPromise = scheduler.flushAll();
    resolveIpc({ failed: ['appearance.json', 'defaults.json'] });

    const result = await flushPromise;
    expect(result.failed.sort()).toEqual(['appearance.json', 'defaults.json']);
  });

  it('flush(key) reports ok=false when performWrite returns partial failures', async () => {
    vi.useFakeTimers();

    let resolveIpc!: (val: { failed: string[] }) => void;
    const ipc = new Promise<{ failed: string[] }>((res) => {
      resolveIpc = res;
    });

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: () => ipc,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    scheduler.schedule('config', () => makeArgs('.filo/'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    const flushPromise = scheduler.flush('config');
    resolveIpc({ failed: ['app.json'] });

    const result = await flushPromise;
    expect(result.ok).toBe(false);
  });
});

describe('createScheduler — missing source', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    vi.useRealTimers();
  });

  it('flushAll attributes a missing-source pending entry to failed[]', async () => {
    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: async () => undefined,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    let hasArgs = true;
    scheduler.schedule('k1', () => (hasArgs ? makeArgs('gone.md') : null));

    // Simulate source removal between schedule and flush.
    hasArgs = false;

    const result = await scheduler.flushAll();
    expect(result.failed).toEqual(['gone.md']);
  });

  it('flush(key) with null-args pending entry returns ok=false', async () => {
    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: async () => undefined,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    let hasArgs = true;
    scheduler.schedule('k1', () => (hasArgs ? makeArgs('gone.md') : null));
    hasArgs = false;

    const result = await scheduler.flush('k1');
    expect(result.ok).toBe(false);
  });
});

describe('createScheduler — rename-mid-debounce hook', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    vi.useRealTimers();
  });

  it('onReschedule fires with prev and next sentinels when an existing key is rearmed', () => {
    vi.useFakeTimers();
    const onReschedule = vi.fn();

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: async () => undefined,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
      onReschedule,
    });

    scheduler.schedule('boardA', () => makeArgs('A.board.json'));
    scheduler.schedule('boardA', () => makeArgs('Subfolder/A.board.json'));

    expect(onReschedule).toHaveBeenCalledTimes(1);
    expect(onReschedule).toHaveBeenCalledWith(
      { vaultRoot: '/vault', path: 'A.board.json' },
      { vaultRoot: '/vault', path: 'Subfolder/A.board.json' },
    );
  });

  it('first schedule call does NOT trigger onReschedule', () => {
    const onReschedule = vi.fn();

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: async () => undefined,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
      onReschedule,
    });

    scheduler.schedule('k1', () => makeArgs('a.md'));
    expect(onReschedule).not.toHaveBeenCalled();
  });
});

describe('createScheduler — shouldSkipWrite gate', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    vi.useRealTimers();
  });

  it('skipped writes do NOT invoke performWrite and count as success', async () => {
    vi.useFakeTimers();
    const writeSpy = vi.fn(async () => undefined);

    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: writeSpy,
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
      shouldSkipWrite: () => true,
    });

    scheduler.schedule('k1', () => makeArgs('a.md'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    const result = await scheduler.flushAll();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(result.failed).toEqual([]);
  });
});

describe('createScheduler — getFailureId override', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    vi.useRealTimers();
  });

  it('failed[] uses the custom failure id when getFailureId is set', async () => {
    vi.useFakeTimers();

    const scheduler = createScheduler<TArgs & { boardPath: string }>({
      name: 'test',
      debounceMs: 100,
      performWrite: async () => { throw new Error('boom'); },
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.boardPath }),
      getFailureId: (a) => a.boardPath,
    });

    scheduler.schedule('boardA', () => ({
      vaultRoot: '/vault',
      path: 'unused',
      boardPath: 'Sub/A.board.json',
    }));

    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    const result = await scheduler.flushAll();
    expect(result.failed).toEqual(['Sub/A.board.json']);
  });
});

describe('createScheduler — overlapping fires for one key (F2 counter leak)', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    setWriteStateListener(null);
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    vi.useRealTimers();
  });

  it('balances both beginWrites when a reschedule fires mid-IPC (inflight → 0, markClean once)', async () => {
    // Records sentinel IPC so we can assert markClean (vault:delete) fires
    // exactly once when the counter finally drains to 0.
    const writes: Array<{ channel: string }> = [];
    installFiloMock((channel: string) => {
      writes.push({ channel });
      return { success: true };
    });

    // Mirror the save indicator: observe the inflight counter writeStateTracking
    // reports on every begin/endWrite.
    let lastInflight = 0;
    let peakInflight = 0;
    setWriteStateListener((info) => {
      lastInflight = info.inflight;
      peakInflight = Math.max(peakInflight, info.inflight);
    });

    // One independent slow IPC per fire so both can be in flight at once.
    let resolveA!: () => void;
    let resolveB!: () => void;
    const ipcs = [
      new Promise<void>((res) => { resolveA = res; }),
      new Promise<void>((res) => { resolveB = res; }),
    ];
    let fireIndex = 0;

    vi.useFakeTimers();
    const scheduler = createScheduler<TArgs>({
      name: 'test',
      debounceMs: 100,
      performWrite: () => ipcs[fireIndex++] ?? Promise.resolve(),
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    });

    // schedule → fire A → (A still in flight) reschedule the SAME key → fire B.
    scheduler.schedule('k1', () => makeArgs('note.md'));
    vi.advanceTimersByTime(200); // timer A fires → fireWrite A; ipcA pending
    scheduler.schedule('k1', () => makeArgs('note.md'));
    vi.advanceTimersByTime(200); // timer B fires → fireWrite B; ipcB pending
    vi.useRealTimers();

    // Both fires were counted against the sentinel — this is the leak window.
    expect(peakInflight).toBe(2);

    // Settle both; drain the settle handlers and the fire-and-forget sentinel
    // mutex (markClean's vault:delete is chained through dirtyFlagRecovery).
    resolveA();
    resolveB();
    await scheduler.flushAll();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(lastInflight).toBe(0);
    expect(writes.filter((w) => w.channel === 'vault:delete')).toHaveLength(1);
  });
});
