import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createScheduler, disposeTestSchedulers } from '../helpers/testSchedulers';
import {
  hasFailedWrites,
  isPathPending,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

// Retire every scheduler a test made, so nothing it left armed reaches the next test.
afterEach(disposeTestSchedulers);

/**
 * Audit-12 M2 — a board/config/misc write that exceeds `writeTimeoutMs` and is
 * marked failed, then LATER succeeds, must self-heal the phantom failed mark.
 *
 * On timeout, `fireWrite` stops awaiting and `markPathFailed`s the path so the
 * `.filo/.dirty` sentinel survives. But the underlying IPC keeps running — on a
 * slow OneDrive/SMB volume it can land seconds later. The markdown + frontmatter
 * schedulers self-heal because their `performWrite` wraps the IPC in
 * `trackComponentWrite` (its late `endWrite(true)` drops the failed path).
 * Board/config/misc call their IPC directly, so without the timeout-branch
 * continuation the failed mark sticks for the whole session:
 * `vaultStore.save()` keeps returning false, `.filo/.dirty` stays set, and the
 * next launch shows a phantom recovery prompt — while the bytes are on disk.
 *
 * These exercise a `sentinelMode: 'full'` scheduler (the board/config/misc
 * shape — no trackComponentWrite) with a controllable deferred write.
 */
describe('Audit-12 M2 — late success self-heals a timed-out failed mark', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('clears the failed path when a timed-out write later succeeds', async () => {
    let resolveWrite: (() => void) | undefined;
    const scheduler = createScheduler<{ path: string }>({
      name: 'test-late-success',
      debounceMs: 5,
      writeTimeoutMs: 40,
      // Board/config/misc shape: IPC directly, default sentinelMode ('full'),
      // no trackComponentWrite wrapper to self-heal via a late endWrite.
      performWrite: () => new Promise<void>((res) => { resolveWrite = res; }),
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    scheduler.schedule('k1', () => ({ path: 'Late.md' }));
    // flushAll drains the pending write and awaits it; the race times out at 40ms.
    const result = await scheduler.flushAll();
    expect(result.failed).toContain('Late.md');
    expect(hasFailedWrites()).toBe(true);
    expect(isPathPending('Late.md')).toBe(true); // failed paths keep the sentinel dirty

    // The underlying IPC finally lands (slow volume catches up).
    expect(resolveWrite).toBeDefined();
    resolveWrite?.();
    // Let the continuation's microtasks settle (await performWrite → .then chain).
    await new Promise((r) => setTimeout(r, 10));

    // Self-healed: the phantom failed mark is gone, so Ctrl+S / quit no longer
    // report "Save failed" and `.filo/.dirty` can clear.
    expect(hasFailedWrites()).toBe(false);
    expect(isPathPending('Late.md')).toBe(false);
  }, 3000);

  it('keeps the path failed when a timed-out write LATER fails too', async () => {
    let rejectWrite: ((err: Error) => void) | undefined;
    const scheduler = createScheduler<{ path: string }>({
      name: 'test-late-failure',
      debounceMs: 5,
      writeTimeoutMs: 40,
      performWrite: () => new Promise<void>((_res, rej) => { rejectWrite = rej; }),
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    scheduler.schedule('k1', () => ({ path: 'StillBad.md' }));
    const result = await scheduler.flushAll();
    expect(result.failed).toContain('StillBad.md');
    expect(hasFailedWrites()).toBe(true);

    // The slow write eventually throws — the failed mark must STAY (real loss).
    expect(rejectWrite).toBeDefined();
    rejectWrite?.(new Error('disk full'));
    await new Promise((r) => setTimeout(r, 10));

    expect(hasFailedWrites()).toBe(true);
    expect(isPathPending('StillBad.md')).toBe(true);
  }, 3000);

  /**
   * Audit-13 M3 — the late-success self-heal must NOT erase a NEWER, legitimate
   * failure for the same path. A write that timed out (W1) keeps running; if a
   * NEWER write (W2) for that path fails in the interim it records a fresh failed
   * mark. When W1 finally lands, an UNCONDITIONAL clear-by-path (the M2 fix on its
   * own) would wipe W2's mark and falsely report the path clean — masking real
   * loss. The per-path write generation gates the heal: W1 only heals if it's
   * still the newest write for its path.
   *
   * Bite: drop the generation guard (clear unconditionally) → the final
   * `hasFailedWrites()` assertion goes red.
   */
  it('does NOT clear the failed mark when a NEWER write for the path failed in the interim', async () => {
    let resolveW1: (() => void) | undefined;
    let call = 0;
    const scheduler = createScheduler<{ path: string }>({
      name: 'test-m3-supersede',
      debounceMs: 5,
      writeTimeoutMs: 40,
      performWrite: () => {
        call++;
        if (call === 1) {
          // W1 — wedged past the timeout; resolved LATE by hand below.
          return new Promise<void>((res) => { resolveW1 = res; });
        }
        // W2 (same path) — fails immediately: a fresh, legitimate failure.
        return Promise.reject(new Error('W2 disk full'));
      },
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    // Fire W1, let it time out → path marked failed (generation 1).
    scheduler.schedule('k1', () => ({ path: 'Same.md' }));
    const r1 = await scheduler.flushAll();
    expect(r1.failed).toContain('Same.md');
    expect(hasFailedWrites()).toBe(true);

    // Fire W2 for the SAME path; it fails → re-marks the path failed (generation 2).
    scheduler.schedule('k1', () => ({ path: 'Same.md' }));
    const r2 = await scheduler.flushAll();
    expect(r2.failed).toContain('Same.md');
    expect(hasFailedWrites()).toBe(true);

    // W1's underlying write finally lands (slow volume catches up). Its late
    // success must NOT heal — a newer write (W2) failed for this path since.
    expect(resolveW1).toBeDefined();
    resolveW1?.();
    await new Promise((r) => setTimeout(r, 20));

    // M3 — the failed mark survives: the path genuinely failed (W2), not clean.
    expect(hasFailedWrites()).toBe(true);
    expect(isPathPending('Same.md')).toBe(true);
  }, 3000);
});
