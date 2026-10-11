import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * `FileWatcher.suppress` keys must be case-folded on Windows/macOS so a
 * renderer-side suppression of `Notes.md` matches an OS-emitted watcher event
 * whose casing differs (`notes.md`, `NOTES.MD`, …). Without the fold the late
 * OS event escapes suppression and reaches `handleExternalMarkdownChanges` as
 * an unwanted "external edit" — surfacing spurious toasts and, worse,
 * classifying Filo's own writes as foreign in the reconcile diff.
 *
 * We verify behaviour through the public surface (`suppress` +
 * `reconcileNow`'s synthesised events) rather than reaching into the
 * private `isSuppressed`, because the synthesis path is the production
 * code path that actually consumes the registry.
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

describe('FileWatcher.suppress — case-fold', () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    sentEvents.length = 0;
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-watcher-case-'));
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

  // The reconciliation diff exposes the suppression registry indirectly:
  // any path that exists in the new snapshot but didn't in the previous
  // one normally synthesises a `vault:files-changed` event. If we suppress
  // that path before the second walk, the synthesis must drop it.
  //
  // The case-fold fix is what makes the suppression match against the
  // OS-emitted casing. On Linux the test path is a pure pass-through; on
  // Windows/macOS the diverging-case path is what would have leaked
  // pre-fix.

  it('suppression matches the OS-emitted casing on case-insensitive filesystems', async () => {
    // Seed an empty snapshot. The reconcile pass will treat every later
    // file as "newly seen".
    await watcher.reconcileNow({ seedOnly: true });

    // Create the file with one casing. Suppression keys it the other way.
    await fs.writeFile(join(dir, 'notes.md'), 'hello', 'utf-8');
    // Renderer-side suppression uses the casing Filo intends to write —
    // either `Notes.md` or `notes.md`. The expectation: a watcher pass
    // that sees the file MUST drop the synthesised event for whichever
    // casing the OS reports. On case-insensitive filesystems this is the
    // bug the fix closes; on Linux (case-sensitive) the suppress + emit
    // casings already match for any single test we write, so the assertion
    // is the same — drop the event.
    watcher.suppress('Notes.md', 5000);

    // Drive the diff. The newly-present file is normally emitted, but the
    // suppression must drop it.
    await watcher.reconcileNow({ seedOnly: false });

    // Allow the 300ms debounce to fire.
    await new Promise((r) => setTimeout(r, 400));

    const leaked = sentEvents.filter((e) => e.channel === 'vault:files-changed');
    expect(leaked).toHaveLength(0);
  });

  it('suppression released after the TTL expires (no permanent stickiness)', async () => {
    await watcher.reconcileNow({ seedOnly: true });
    // Suppression window of 50ms — small enough that the test waits less
    // than the debounce cycle to land in the post-expiry state.
    watcher.suppress('AnyCase.md', 50);
    await new Promise((r) => setTimeout(r, 100));

    await fs.writeFile(join(dir, 'AnyCase.md'), 'after expiry', 'utf-8');
    await watcher.reconcileNow({ seedOnly: false });
    await new Promise((r) => setTimeout(r, 400));

    // Once the TTL expires, a new event MUST reach the renderer — the
    // fold mustn't accidentally cache a "permanent" entry.
    const leaked = sentEvents.filter((e) => e.channel === 'vault:files-changed');
    expect(leaked.length).toBeGreaterThan(0);
  });

  it('a sibling file with a similar prefix is NOT swallowed by suppress', async () => {
    // Sanity check: the case-fold must NOT collapse two genuinely
    // different basenames into one another. `Notes.md` and `notes2.md`
    // share a prefix but are distinct files — only the exact match
    // should be suppressed.
    await watcher.reconcileNow({ seedOnly: true });

    watcher.suppress('Notes.md', 5000);
    await fs.writeFile(join(dir, 'notes2.md'), 'sibling', 'utf-8');
    await watcher.reconcileNow({ seedOnly: false });
    await new Promise((r) => setTimeout(r, 400));

    const events = sentEvents.filter((e) => e.channel === 'vault:files-changed');
    // The sibling file should produce exactly one event group (one
    // debounced batch). The shape of the payload is `FileChangeEvent[]`;
    // we just need at least one event for `notes2.md`.
    const haveSibling = events.some((e) => {
      const list = e.payload[0] as Array<{ filename: string }>;
      return list.some((c) => c.filename.toLowerCase() === 'notes2.md');
    });
    expect(haveSibling).toBe(true);
  });
});
