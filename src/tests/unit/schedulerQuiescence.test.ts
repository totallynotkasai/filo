import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createScheduler, disposeTestSchedulers } from '../helpers/testSchedulers';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

// Retire every scheduler a test made, so nothing it left armed reaches the next test.
afterEach(disposeTestSchedulers);

/**
 * Scheduler quiescence-parity.
 *
 * `writeScheduler` has THREE independent places that decide "is this key /
 * scheduler quiescent?":
 *   1. flush(key) EARLY-RETURN      — pending ∅ AND inFlight ∅ AND parked ∅
 *   2. flush(key) DRAIN LOOP        — while (inFlight.size || parked.size)
 *   3. flushAll() PARKED-DRAIN LOOP — while (anyParked() || inFlight.size)
 *
 * The early-return (#1) was once `parked`-BLIND: in the one-microtask gap where a
 * write is parked behind a just-settled in-flight write (pending + inFlight both
 * empty, parked NOT), a single-key flush (tab-close) returned {ok:true} before
 * the newest edit landed — a false "saved". The drain loop (#2) and flushAll (#3)
 * already checked `parked`; only the early-return missed it. That is the dominant
 * shape of bugs in this scheduler (a hardened path whose sibling missed the same
 * fix), so this suite pins that ALL THREE honor `parked` against the SAME
 * constructed state — a future edit can't fix/refactor one and leave a sibling
 * blind.
 *
 * `__parkForTests(key)` builds the otherwise production-unreachable isolated gap
 * (parked non-empty; pending + inFlight empty) directly, so flush() and flushAll()
 * are exercised against identical state and must agree.
 */

function tick(ms = 25): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Args {
  path: string;
}

function makeScheduler(name: string) {
  return createScheduler<Args>({
    name,
    debounceMs: 5,
    performWrite: () => Promise.resolve(),
    getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
  });
}

describe('scheduler quiescence parity (flush early-return, flush drain loop, flushAll all honor `parked`)', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('flush(key) does not report done while a write is parked with empty pending/inFlight', async () => {
    const s = makeScheduler('quiesce-flush');
    const release = s.__parkForTests('k');

    let resolved = false;
    const p = s.flush('k').then((r) => {
      resolved = true;
      return r;
    });

    await tick();
    // Bite: a `parked`-blind early-return returns {ok:true} immediately.
    expect(resolved).toBe(false);

    release();
    const result = await p;
    expect(resolved).toBe(true);
    expect(result.ok).toBe(true);
  }, 5000);

  it('flushAll() does not resolve while a write is parked with empty pending/inFlight (same isolated gap)', async () => {
    const s = makeScheduler('quiesce-flushall');
    const release = s.__parkForTests('k');

    let resolved = false;
    const p = s.flushAll().then((r) => {
      resolved = true;
      return r;
    });

    await tick();
    // Bite: a flushAll loop guarded only on `inFlight.size` (dropping
    // `anyParked()`) never enters and resolves immediately against this gap.
    expect(resolved).toBe(false);

    release();
    const result = await p;
    expect(resolved).toBe(true);
    expect(result.failed).toEqual([]);
  }, 5000);

  it('hasPendingTimer is armed-timer-ONLY by design: a parked write is invisible to it', () => {
    // hasPendingTimer must NOT fold in parked/inFlight: those carry no args, and
    // including them would pin the gateway's post-write markClean caller dirty
    // forever (it asks "is a NEWER timer armed?"). Durability instead relies on
    // the sentinel ledger (isPathPending) + the flush/flushAll quiescence checks
    // above. This pins the deliberate divergence so a future "consistency" edit
    // doesn't make hasPendingTimer see parked and silently break markClean.
    const s = makeScheduler('quiesce-haspending');
    const release = s.__parkForTests('k');
    expect(s.hasPendingTimer(() => true)).toBe(false);
    release();
  });
});
