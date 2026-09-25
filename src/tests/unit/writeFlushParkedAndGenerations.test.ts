import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createScheduler } from '@renderer/lib/boards/writeScheduler';
import {
  __resetDirtyTrackingForTests,
  trackComponentWrite,
  hasFailedWrites,
  __componentWriteGenSizeForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-14 Phase 1 — write-drain & recovery integrity.
 *
 * Covers the scheduler / write-tracking fixes:
 *  - 1.1 a write PARKED behind an in-flight write is awaited by flushAll/flush
 *  - 1.4 a superseded late write is told `isLatestWrite() === false`
 *  - 1.5 a late component-write success does not clear a NEWER writer's failure
 *  - 1.6 `writeGenByPath` prunes back to ~0 after writes complete
 *
 * The recovery-store fixes (1.2 acknowledgeRecovery idle-gate, 1.3 launchId
 * sentinel suppression) live in `vaultRecovery.test.ts` / `dirtyFlagRecovery.test.ts`.
 */

/** Polls `cond` on real timers until true or the deadline elapses. */
function waitFor(cond: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor: condition never became true'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

describe('Audit-14 1.1 — flush/flushAll await a write parked behind an in-flight write', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('flushAll does not resolve until the parked write has landed', async () => {
    interface Args { path: string; tag: string }
    const starts: string[] = [];
    const landed: string[] = [];
    const resolvers = new Map<string, () => void>();

    const scheduler = createScheduler<Args>({
      name: 'parked-flushall',
      debounceMs: 5,
      performWrite: (args) => {
        starts.push(args.tag);
        return new Promise<void>((res) => {
          resolvers.set(args.tag, () => { landed.push(args.tag); res(); });
        });
      },
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    // A fires → in flight (deferred on its resolver).
    scheduler.schedule('k', () => ({ path: 'N.md', tag: 'A' }));
    await waitFor(() => starts.includes('A'));

    // B (newer, same key) fires → sees A in flight → PARKS behind A's drain.
    scheduler.schedule('k', () => ({ path: 'N.md', tag: 'B' }));
    await new Promise((r) => setTimeout(r, 40));
    expect(starts).toEqual(['A']); // B is parked, not fired yet.

    // flushAll() called WHILE B is parked — it must not resolve until B lands.
    let flushResolved = false;
    const flushP = scheduler.flushAll().then((r) => { flushResolved = true; return r; });

    await new Promise((r) => setTimeout(r, 20));
    expect(flushResolved).toBe(false); // still pending — A in flight, B parked.

    // A lands → B's drain completes → B fires.
    resolvers.get('A')!();
    await waitFor(() => starts.includes('B'));
    await new Promise((r) => setTimeout(r, 20));
    expect(flushResolved).toBe(false); // still pending — B now in flight, unawaited would be a bug.

    // B lands → flushAll resolves.
    resolvers.get('B')!();
    const result = await flushP;
    expect(flushResolved).toBe(true);
    expect(landed).toEqual(['A', 'B']);
    expect(result.failed).toEqual([]);
  }, 5000);

  it('flush(key) also awaits a write parked behind an in-flight write', async () => {
    interface Args { path: string; tag: string }
    const starts: string[] = [];
    const landed: string[] = [];
    const resolvers = new Map<string, () => void>();

    const scheduler = createScheduler<Args>({
      name: 'parked-flush',
      debounceMs: 5,
      performWrite: (args) => {
        starts.push(args.tag);
        return new Promise<void>((res) => {
          resolvers.set(args.tag, () => { landed.push(args.tag); res(); });
        });
      },
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    scheduler.schedule('k', () => ({ path: 'N.md', tag: 'A' }));
    await waitFor(() => starts.includes('A'));
    scheduler.schedule('k', () => ({ path: 'N.md', tag: 'B' }));
    await new Promise((r) => setTimeout(r, 40));
    expect(starts).toEqual(['A']);

    let flushResolved = false;
    const flushP = scheduler.flush('k').then((r) => { flushResolved = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(flushResolved).toBe(false);

    resolvers.get('A')!();
    await waitFor(() => starts.includes('B'));
    await new Promise((r) => setTimeout(r, 20));
    expect(flushResolved).toBe(false);

    resolvers.get('B')!();
    const result = await flushP;
    expect(flushResolved).toBe(true);
    expect(landed).toEqual(['A', 'B']);
    expect(result.ok).toBe(true);
  }, 5000);
});

describe('Audit-15 P1.1 — flush(key) early-return blocks on a still-parked write', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  // The Audit-14 1.1 tests above call flush WHILE the prior write is still in
  // flight, so flush enters via the (correct) inFlight-non-empty drain loop. This
  // test isolates the EARLY-RETURN: the prod-unreachable one-microtask gap where
  // the prior write has already left `inFlight` but the parked fire hasn't
  // registered its own entry yet — pending + inFlight both empty, parked NOT. The
  // pre-fix early-return ignored `parked` and reported {ok:true} before the parked
  // edit landed. `__parkForTests` constructs exactly that gap state.
  it('does not resolve {ok:true} while a write is parked with empty pending/inFlight', async () => {
    interface Args { path: string }
    const scheduler = createScheduler<Args>({
      name: 'parked-early-return',
      debounceMs: 5,
      performWrite: () => Promise.resolve(),
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    const releaseParked = scheduler.__parkForTests('k');

    let resolved = false;
    const flushP = scheduler.flush('k').then((r) => {
      resolved = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 20));
    // Pre-fix: the early-return returned {ok:true} immediately → resolved here.
    expect(resolved).toBe(false);

    releaseParked();
    const result = await flushP;
    expect(resolved).toBe(true);
    expect(result.ok).toBe(true);
  }, 5000);
});

describe('Audit-14 1.4 — a superseded late write is told it is not the latest', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('the superseded write sees isLatestWrite()===false; the newest sees true', async () => {
    interface Args { path: string; tag: string }
    const resolvers = new Map<string, () => void>();
    const latestAtEnd = new Map<string, boolean>();

    const scheduler = createScheduler<Args>({
      name: 'gen-currency',
      debounceMs: 5,
      // Small bound so the wedged A is abandoned by the drain and B fires.
      writeTimeoutMs: 30,
      performWrite: (args, ctx) =>
        new Promise<void>((res) => {
          resolvers.set(args.tag, () => {
            // Evaluate currency at the moment the write "lands", like the board
            // writer does just before stamping the drift baseline.
            latestAtEnd.set(args.tag, ctx.isLatestWrite());
            res();
          });
        }),
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    // A fires and wedges past writeTimeoutMs.
    scheduler.schedule('k', () => ({ path: 'N.md', tag: 'A' }));
    await waitFor(() => resolvers.has('A'));

    // B (newer, same path) parks behind A; once A's tracker times out (30 ms)
    // the drain releases and B fires.
    scheduler.schedule('k', () => ({ path: 'N.md', tag: 'B' }));
    await waitFor(() => resolvers.has('B'), 3000);

    // The newest write (B) is still the latest for the path.
    resolvers.get('B')!();
    await waitFor(() => latestAtEnd.has('B'));
    expect(latestAtEnd.get('B')).toBe(true);

    // A lands LATE — it was superseded by B, so it must report not-latest
    // (the board writer uses this to SKIP stamping the drift baseline).
    resolvers.get('A')!();
    await waitFor(() => latestAtEnd.has('A'));
    expect(latestAtEnd.get('A')).toBe(false);
  }, 6000);
});

describe('Audit-14 1.5 — a late component-write success does not clear a newer failure', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it("older slow success leaves the newer writer's failure intact for the same path", async () => {
    let resolveX!: () => void;
    // Writer X (older) — slow, will SUCCEED late.
    const xPromise = trackComponentWrite(
      '/vault',
      'P.md',
      () => new Promise<void>((res) => { resolveX = res; }),
      { notifyOnError: false },
    );

    // Writer Y (newer) for the SAME path — fails immediately. Bumps the
    // per-path generation past X's.
    await expect(
      trackComponentWrite(
        '/vault',
        'P.md',
        () => Promise.reject(new Error('boom')),
        { notifyOnError: false },
      ),
    ).rejects.toThrow();

    // Y's legitimate failure is recorded.
    expect(hasFailedWrites()).toBe(true);

    // X succeeds LATE. Its endWrite(true) is gen-gated: X is no longer the
    // newest write for P.md, so it must NOT clear Y's failure.
    resolveX();
    await xPromise;
    expect(hasFailedWrites()).toBe(true);
  });

  it('the generation map prunes back to ~0 once writes settle', async () => {
    await trackComponentWrite('/vault', 'a.md', () => Promise.resolve(), { notifyOnError: false });
    await trackComponentWrite('/vault', 'b.md', () => Promise.resolve(), { notifyOnError: false });
    await trackComponentWrite('/vault', 'c.md', () => Promise.resolve(), { notifyOnError: false });
    expect(__componentWriteGenSizeForTests()).toBe(0);
  });
});

describe('Audit-14 1.6 — writeGenByPath prunes back after writes complete', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('returns to 0 after N distinct paths are written to completion', async () => {
    interface Args { path: string }
    const scheduler = createScheduler<Args>({
      name: 'gen-prune',
      debounceMs: 5,
      performWrite: () => Promise.resolve(),
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    for (let i = 0; i < 6; i++) {
      scheduler.schedule(`k${i}`, () => ({ path: `N${i}.md` }));
    }
    const result = await scheduler.flushAll();
    expect(result.failed).toEqual([]);
    // Each successful, still-newest, now-clean settle pruned its entry.
    expect(scheduler.__writeGenSizeForTests()).toBe(0);
  }, 5000);
});
