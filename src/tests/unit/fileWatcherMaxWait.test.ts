import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Audit-13 L20 — the trailing-edge notify debounce now carries a max-wait cap.
 *
 * The plain trailing debounce (`scheduleNotify`) re-arms on every event, so a
 * continuous sub-300ms external write stream (a sync client doing many small
 * writes, an appending logger) would never fire `notifyRenderers` until the
 * stream paused — the sidebar/index stalled for the whole burst, recovered only
 * by the 30s reconcile. The fix tracks when the OLDEST unfired event was queued
 * and caps the delay so a flush lands within ~1s even under a steady stream,
 * while a single event still gets the full debounce window (no early flush).
 */

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { FileWatcher } from '../../main/services/fileWatcher';

// Narrow view of the private members this test drives deterministically.
type Internals = {
  scheduleNotify(): void;
  notifyRenderers: () => Promise<void>;
};

describe('FileWatcher — notify debounce max-wait cap (Audit-13 L20)', () => {
  let dir: string;
  let watcher: FileWatcher;
  let notifySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-watcher-maxwait-'));
    watcher = new FileWatcher(dir);
    notifySpy = vi.fn().mockResolvedValue(undefined);
    (watcher as unknown as Internals).notifyRenderers = notifySpy;
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await watcher.stop();
    } catch {
      /* ignore */
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('fires within the max-wait cap (~1s) under a continuous sub-debounce stream', async () => {
    const internal = watcher as unknown as Internals;
    vi.useFakeTimers({ now: 0 });

    // Re-arm every 100 ms (below the 300 ms debounce) for a full second — a
    // pure trailing debounce would never fire because each event resets it.
    for (let t = 0; t < 1000; t += 100) {
      internal.scheduleNotify();
      await vi.advanceTimersByTimeAsync(100);
    }

    // The max-wait cap forced exactly one flush despite the unbroken stream.
    expect(notifySpy).toHaveBeenCalled();
  });

  it('a single event still waits the full debounce window (no early flush)', async () => {
    const internal = watcher as unknown as Internals;
    vi.useFakeTimers({ now: 0 });

    internal.scheduleNotify();
    await vi.advanceTimersByTimeAsync(299);
    expect(notifySpy).not.toHaveBeenCalled(); // still inside the 300 ms window
    await vi.advanceTimersByTimeAsync(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it('a paused-then-resumed stream starts a fresh max-wait window', async () => {
    const internal = watcher as unknown as Internals;
    vi.useFakeTimers({ now: 0 });

    // First event flushes after the full debounce (stream paused).
    internal.scheduleNotify();
    await vi.advanceTimersByTimeAsync(300);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // A later event must NOT inherit the first window's elapsed time — it gets
    // its own full debounce, proving `debounceFirstQueuedAt` reset on fire.
    internal.scheduleNotify();
    await vi.advanceTimersByTimeAsync(299);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(notifySpy).toHaveBeenCalledTimes(2);
  });
});
