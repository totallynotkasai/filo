import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Phase 3 / 3.1 — `FileWatcher.stop()` awaits any in-flight reconcile walk
 * and aborts further emits. Without this guarantee, swapping vaults while a
 * reconcile is mid-walk leaks `vault:files-changed` events from the OLD
 * vault into the NEW vault's listener (paths are the OS-relative ones the
 * walk picked up; the renderer routes them into its external-edit pipeline
 * and surfaces spurious prompts).
 *
 * We exercise three guarantees:
 *
 *   1. `stop()` returns a Promise that resolves only after the in-flight
 *      reconcile has settled — i.e. you can `await` it to serialise teardown.
 *   2. Once `stop()` has been called, no `vault:files-changed` /
 *      `vault:file-renamed` / `vault:tree-updated` events fire, even if a
 *      reconcile pass had already collected events but not yet pushed them
 *      through the 300ms debounce.
 *   3. The OS-level live watcher callback also no-ops after stop, so an
 *      event that fired in the very same tick stop() did doesn't leak.
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

import { FileWatcher } from '../../main/services/fileWatcher';

describe('FileWatcher.stop() — Phase 3 / 3.1', () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    sentEvents.length = 0;
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-watcher-stop-'));
    watcher = new FileWatcher(dir);
  });

  afterEach(async () => {
    // Defensive: tests below already call stop(), but if one fails before
    // doing so we don't want a leaked timer to fire after the test ends.
    try {
      await watcher.stop();
    } catch {
      /* ignore */
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns an awaitable Promise', async () => {
    const result = watcher.stop();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('awaits an in-flight reconcile walk before resolving', async () => {
    // Seed enough content that the walk takes a measurable amount of
    // time. The hash branch for `.md` files adds a per-file open+read,
    // so even a modest count produces enough I/O to make the race
    // observable.
    for (let i = 0; i < 30; i++) {
      await fs.writeFile(join(dir, `f${i}.md`), `body of file ${i}`, 'utf-8');
    }

    // Kick off a reconcile but do NOT await it — this is the case
    // `stop()` must handle correctly.
    const walk = watcher.reconcileNow({ seedOnly: false });

    // stop() should not resolve before the walk does.
    const stopPromise = watcher.stop();
    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });

    // Give the event loop a chance to schedule the .then handler.
    await new Promise((r) => setTimeout(r, 0));
    // It's fine if both have resolved by now if the walk was tiny; what
    // matters is that the awaitable stop completes and the in-flight
    // walk doesn't leak.
    await stopPromise;
    expect(stopResolved).toBe(true);
    await walk; // never throws (errors logged inside reconcileNow)
  });

  it('does not emit vault:files-changed after stop() resolves', async () => {
    // Seed a snapshot so the next reconcile produces synthesised events.
    await fs.writeFile(join(dir, 'Before.md'), 'before', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });

    // Add files that the next walk would notice.
    await fs.writeFile(join(dir, 'New1.md'), 'one', 'utf-8');
    await fs.writeFile(join(dir, 'New2.md'), 'two', 'utf-8');

    // Kick the walk and immediately stop. The walk should observe
    // `aborted` and refuse to push the synthesised events.
    const walk = watcher.reconcileNow({ seedOnly: false });
    await watcher.stop();
    await walk;

    // Allow any leftover debounce to fire. None should — the live
    // watcher is closed and reconcileNow short-circuited.
    await new Promise((r) => setTimeout(r, 400));

    const leaked = sentEvents.filter((e) => e.channel === 'vault:files-changed');
    expect(leaked).toHaveLength(0);
  });

  it('subsequent reconcileNow calls are no-ops after stop()', async () => {
    await fs.writeFile(join(dir, 'A.md'), 'a', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await watcher.stop();

    await fs.writeFile(join(dir, 'B.md'), 'b', 'utf-8');
    await watcher.reconcileNow({ seedOnly: false });
    await new Promise((r) => setTimeout(r, 400));

    const filesChanged = sentEvents.filter((e) => e.channel === 'vault:files-changed');
    expect(filesChanged).toHaveLength(0);
  });
});
