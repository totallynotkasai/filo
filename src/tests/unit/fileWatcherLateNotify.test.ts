import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * `notifyRenderers` awaits `correlateRenames` (real fs hash
 * probes — hundreds of ms on slow volumes) and then sends
 * `vault:files-changed` / `vault:file-renamed` / `vault:tree-updated` with
 * no `aborted` re-check, and `stop()` never tracked the in-flight notify
 * pass. A vault swap completing inside the probe window therefore let the
 * OLD vault's rename/change events land on the NEW vault's renderer — whose
 * rename queue captures vault identity at ARRIVAL time, so the events pass
 * the identity guard and drive the rename cascade / external-edit pipeline
 * against the new vault's same-named files (persistent cross-vault
 * corruption, no undo).
 *
 * Guarantees pinned here:
 *   1. `stop()` does not resolve while a notify pass is parked inside
 *      `correlateRenames` (the in-flight notify is tracked like the
 *      reconcile walk).
 *   2. When the probe finally resolves AFTER `stop()`, zero events are
 *      sent (the post-await `aborted` re-check).
 *   3. Positive control: the same flow WITHOUT stop() does send events —
 *      so assertion 2 isn't vacuously green.
 */

const sentEvents: Array<{ channel: string; payload: unknown[] }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, ...payload: unknown[]) => {
            sentEvents.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

// Gate correlateRenames so the test controls exactly when the notify pass's
// single await resolves. `gate` is swapped per test; `entered` lets the test
// wait until the notify pass is genuinely parked inside the probe.
let gate: Promise<void> = Promise.resolve();
let signalEntered: (() => void) | null = null;
const entered = (): Promise<void> =>
  new Promise<void>((resolve) => {
    signalEntered = resolve;
  });

vi.mock('../../main/services/renameCorrelation', () => ({
  correlateRenames: async (unique: unknown[]) => {
    signalEntered?.();
    signalEntered = null;
    await gate;
    return { filtered: unique, renames: [], conflicts: [], changedOnMove: [] };
  },
}));

import { FileWatcher } from '../../main/services/fileWatcher';

describe('late notify pass cannot emit after stop()', () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    sentEvents.length = 0;
    gate = Promise.resolve();
    signalEntered = null;
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-late-notify-'));
    watcher = new FileWatcher(dir);
  });

  afterEach(async () => {
    try {
      await watcher.stop();
    } catch {
      /* ignore */
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * Seeds the snapshot, creates a new file, and runs a reconcile pass so a
   * synthesised create event arms the notify debounce; resolves once the
   * notify pass is parked inside the gated correlateRenames.
   */
  async function driveNotifyIntoProbe(): Promise<void> {
    await fs.writeFile(join(dir, 'Before.md'), 'before', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.writeFile(join(dir, 'New.md'), 'new file', 'utf-8');
    const parked = entered();
    await watcher.reconcileNow({ seedOnly: false });
    // The debounce is up to 300ms; wait for the pass to actually enter the
    // probe rather than sleeping a fixed amount.
    await parked;
  }

  it('stop() awaits the parked notify pass, and the late resolution emits nothing', async () => {
    let releaseGate!: () => void;
    gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    await driveNotifyIntoProbe();

    // The vault swap: stop() must not resolve while the notify pass is
    // still parked inside the probe.
    let stopResolved = false;
    const stopPromise = watcher.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopResolved).toBe(false);

    // The slow volume finally answers — AFTER the swap. The post-await
    // aborted re-check must refuse to send anything.
    releaseGate();
    await stopPromise;
    await new Promise((r) => setTimeout(r, 20));

    const leaked = sentEvents.filter((e) =>
      e.channel === 'vault:files-changed'
      || e.channel === 'vault:file-renamed'
      || e.channel === 'vault:tree-updated');
    expect(leaked).toHaveLength(0);
  });

  it('positive control: without stop() the same flow does emit', async () => {
    await driveNotifyIntoProbe();
    // Gate is already resolved; give the pass a tick to finish sending.
    await new Promise((r) => setTimeout(r, 50));

    const sent = sentEvents.filter((e) => e.channel === 'vault:files-changed');
    expect(sent.length).toBeGreaterThan(0);
  });
});
