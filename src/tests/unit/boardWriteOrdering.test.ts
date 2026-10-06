import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createScheduler, disposeTestSchedulers } from '../helpers/testSchedulers';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

// Retire every scheduler a test made, so nothing it left armed reaches the next test.
afterEach(disposeTestSchedulers);

/**
 * Audit-13 H1 — board/config/misc writes can land out of order and silently
 * clobber newer data on a slow / synced volume.
 *
 * The WC-3 / H4 "drain the older in-flight write before firing the newer one so
 * the newest lands LAST" fix existed only on the `flush()` / `flushAll()` paths.
 * The common ACTIVE-EDITING path is the debounce TIMER, which just fired
 * `void fireWrite(...)` with no pre-drain. If a prior write for the same key was
 * still in flight (a stalled OneDrive/SMB handle), the two `board:save` / config
 * IPCs overlapped and the OS could land the OLDER one last — clobbering the newer
 * payload, after which the post-write `vault:stat` stamped the drift baseline to
 * the stale bytes so the next edit saw "no drift" and never warned.
 *
 * The fix makes the timer-fire path drain the prior in-flight write for the key
 * first (re-reading args AFTER the drain so the freshest state is written),
 * mirroring `flush()` / `flushAll()`. These tests drive the TIMER path
 * (`schedule` + real-timer debounce), not flush.
 *
 * Bite: revert the timer-fire drain (`schedule`'s setTimeout fires
 * `fireFromTimer()` synchronously again) → "no overlap" + "freshest args" go red.
 */
describe('Audit-13 H1 — timer-fire path serializes per key (newest write lands last)', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    // The scheduler's begin/endWrite drive markDirty/markClean (fire-and-forget
    // IPC). Provide a silent bridge so test:unit:strict stays noise-free.
    installFiloMock(() => ({ ok: true, success: true }));
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

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

  it('a newer debounced write does not overlap an in-flight older write; newest lands last', async () => {
    interface OrderArgs { path: string; tag: string }
    const starts: string[] = [];
    const landed: string[] = [];
    let active = 0;
    let maxActive = 0;
    const resolvers = new Map<string, () => void>();

    const scheduler = createScheduler<OrderArgs>({
      name: 'order-test',
      debounceMs: 5,
      performWrite: (args) => {
        starts.push(args.tag);
        active++;
        maxActive = Math.max(maxActive, active);
        return new Promise<void>((res) => {
          resolvers.set(args.tag, () => {
            landed.push(args.tag);
            active--;
            res();
          });
        });
      },
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    // Arm W1 and let its debounce timer fire → W1 is in flight (deferred).
    scheduler.schedule('k', () => ({ path: 'Note.md', tag: 'W1' }));
    await waitFor(() => starts.includes('W1'));

    // Arm W2 (newer) for the SAME key while W1 is still in flight. Give W2's
    // timer ample time to fire (debounce is 5ms). With the fix it drains W1
    // first, so W2 must NOT have started its write yet.
    scheduler.schedule('k', () => ({ path: 'Note.md', tag: 'W2' }));
    await new Promise((r) => setTimeout(r, 40));
    expect(starts).toEqual(['W1']);

    // W1 lands → W2's drain completes → W2 fires.
    resolvers.get('W1')!();
    await waitFor(() => starts.includes('W2'));
    resolvers.get('W2')!();

    await scheduler.flushAll();

    // Never two writes in flight at once, and the newest write landed last.
    expect(maxActive).toBe(1);
    expect(starts).toEqual(['W1', 'W2']);
    expect(landed).toEqual(['W1', 'W2']);
  }, 5000);

  it('re-reads the freshest args after draining the prior write (newest state wins)', async () => {
    interface ValueArgs { path: string; value: string }
    const writes: string[] = [];
    const resolvers = new Map<string, () => void>();
    let fireCount = 0;
    let live = 'A';

    const scheduler = createScheduler<ValueArgs>({
      name: 'fresh-args-test',
      debounceMs: 5,
      performWrite: (args) => {
        writes.push(args.value);
        const id = `w${++fireCount}`;
        return new Promise<void>((res) => resolvers.set(id, res));
      },
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });

    // W1 fires reading live='A'.
    scheduler.schedule('k', () => ({ path: 'N.md', value: live }));
    await waitFor(() => writes.length === 1);
    expect(writes).toEqual(['A']);

    // Arm W2 while W1 is in flight; its getArgs reads `live` at FIRE time.
    live = 'B';
    scheduler.schedule('k', () => ({ path: 'N.md', value: live }));
    await new Promise((r) => setTimeout(r, 40));
    // User keeps editing while W1 is still wedged in flight.
    live = 'C';
    expect(writes).toEqual(['A']); // W2 hasn't fired — it's draining W1.

    // W1 lands → W2 drains, then re-reads `live` (now 'C') and writes the
    // FRESHEST state, not the schedule-time 'B'.
    resolvers.get('w1')!();
    await waitFor(() => writes.length === 2);
    expect(writes[1]).toBe('C');

    resolvers.get('w2')!();
    await scheduler.flushAll();
  }, 5000);
});
