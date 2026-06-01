/**
 * markdownFileWriter (Phase 2 / Pre-Daily-Use Plan 2026-05-25) — gateway
 * contract tests.
 *
 * Locks down four guarantees from the plan exit criteria:
 *  1. BOM round-trip preserved across hydrate → write.
 *  2. `writeMarkdownFile` rejects when not hydrated.
 *  3. `cancelAllMarkdownWrites` drains every caller's pending timer.
 *  4. The vault-swap `pre-swap` hook clears state so a write armed against
 *     the outgoing vault can't fire after the new vault opens.
 *
 * Plus a few sibling guarantees that round out the contract:
 *  - `scheduleMarkdownWrite` coalesces same-callerId calls (latest args win).
 *  - `flushMarkdownWrite` drains a single caller's pending write.
 *  - `flushAllMarkdownWrites` surfaces per-caller failures.
 *  - Force-writer registry routes Keep-local through fresh-args callbacks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markHydrated,
  clearHydrated,
  isHydrated,
  writeMarkdownFile,
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  flushAllMarkdownWrites,
  cancelAllMarkdownWrites,
  registerForceWriter,
  forceWriteForDocument,
  __resetMarkdownFileWriterForTests,
  type WriteArgs,
} from '../../renderer/lib/vault/markdownFileWriter';
import { fireVaultSwap } from '../../renderer/core/vaultLifecycle';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/boardSaver';
import { vaultIndexStore } from '../../renderer/stores/vaultIndex.svelte';
import {
  noteBaseline,
  getBaseline,
  __resetBaselinesForTests,
} from '../../renderer/lib/vault/fileBaselineRegistry';

interface InvokeArgs {
  channel: string;
  args: unknown[];
}

function installFiloStub(): InvokeArgs[] {
  const captured: InvokeArgs[] = [];
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      // Default: every IPC succeeds.
      return { success: true, ok: true };
    },
    on: () => () => {},
    send: () => {},
  };
  return captured;
}

function uninstallFiloStub(): void {
  // Audit2 2.3 — the markdown gateway now lays down the `.filo/.dirty` sentinel
  // asynchronously on schedule/flush/cancel (sentinel-mode 'pending-path').
  // Those fire-and-forget markDirty/markClean ops can resolve AFTER the test
  // body, so restore a SILENT no-op stub rather than deleting `window.filo` —
  // a deferred sentinel write must never hit `undefined.invoke` (the strict
  // test-hygiene gate forbids the resulting TypeError). The `afterEach` drain
  // below normally flushes them first; this is the belt-and-suspenders.
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => undefined,
    on: () => () => {},
    send: () => {},
  };
}

describe('markdownFileWriter — gateway contract', () => {
  let invokes: InvokeArgs[];

  beforeEach(() => {
    invokes = installFiloStub();
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
  });
  afterEach(async () => {
    // Audit2 2.3 — drain the fire-and-forget `.filo/.dirty` sentinel writes the
    // gateway now queues on schedule/flush/cancel (pending-path mode) so they
    // resolve against the live stub before we tear it down — both to avoid a
    // deferred op hitting a stale `window.filo` and to keep them from leaking
    // into the next test's captured invokes. One macrotask drains the whole
    // microtask-chained sentinel mutex; the 300 ms write timers never fire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    uninstallFiloStub();
  });

  it('round-trips a leading UTF-8 BOM across hydrate → write', async () => {
    const relPath = 'Notes/bom.md';
    markHydrated(relPath, true);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { tags: ['kept'] },
      body: 'Hello',
      callerId: 'test-bom',
      docId: null,
    });

    const write = invokes.find((i) => i.channel === 'vault:write-existing-file-text');
    expect(write).toBeDefined();
    const written = write!.args[2] as string;
    // The leading three bytes of the assembled file must be the BOM.
    expect(written.charCodeAt(0)).toBe(0xfeff);
    // The frontmatter should follow the BOM, not lose it.
    expect(written.slice(1, 4)).toBe('---');
  });

  it('omits the BOM when the file was hydrated without one', async () => {
    const relPath = 'Notes/plain.md';
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { tags: ['kept'] },
      body: 'Hello',
      callerId: 'test-plain',
      docId: null,
    });

    const write = invokes.find((i) => i.channel === 'vault:write-existing-file-text');
    const written = write!.args[2] as string;
    expect(written.charCodeAt(0)).not.toBe(0xfeff);
    expect(written.startsWith('---')).toBe(true);
  });

  it('rejects writeMarkdownFile when relPath is not hydrated', async () => {
    await expect(
      writeMarkdownFile({
        vaultRoot: '/vault',
        relPath: 'Notes/ghost.md',
        frontmatter: {},
        body: '',
        callerId: 'unhydrated',
        docId: null,
      }),
    ).rejects.toThrow(/not hydrated/);
    // And NO IPC was issued — the gate runs before any disk work.
    expect(invokes.some((i) => i.channel === 'vault:write-existing-file-text')).toBe(false);
  });

  it('markHydrated / isHydrated / clearHydrated round-trip', () => {
    const path = 'a/b/c.md';
    expect(isHydrated(path)).toBe(false);
    markHydrated(path, true);
    expect(isHydrated(path)).toBe(true);
    clearHydrated(path);
    expect(isHydrated(path)).toBe(false);
  });

  it('scheduleMarkdownWrite coalesces same-callerId calls — latest args win', async () => {
    vi.useFakeTimers();
    try {
      const relPath = 'Notes/coalesce.md';
      markHydrated(relPath, false);

      scheduleMarkdownWrite({
        vaultRoot: '/vault',
        relPath,
        frontmatter: {},
        body: 'first',
        callerId: 'coalesce-caller',
      });
      scheduleMarkdownWrite({
        vaultRoot: '/vault',
        relPath,
        frontmatter: {},
        body: 'second',
        callerId: 'coalesce-caller',
      });
      scheduleMarkdownWrite({
        vaultRoot: '/vault',
        relPath,
        frontmatter: {},
        body: 'third',
        callerId: 'coalesce-caller',
      });

      vi.runAllTimers();
      // Yield so the writeMarkdownFile microtask runs.
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 0));

      const writes = invokes.filter((i) => i.channel === 'vault:write-existing-file-text');
      expect(writes).toHaveLength(1);
      // The latest args win — body should be "third\n" (gateway adds trailing newline).
      const written = writes[0].args[2] as string;
      expect(written).toContain('third');
      expect(written).not.toContain('first');
      expect(written).not.toContain('second');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushMarkdownWrite drains a single caller without affecting others', async () => {
    vi.useFakeTimers();
    try {
      markHydrated('a.md', false);
      markHydrated('b.md', false);

      scheduleMarkdownWrite({
        vaultRoot: '/vault',
        relPath: 'a.md',
        frontmatter: {},
        body: 'a',
        callerId: 'a',
      });
      scheduleMarkdownWrite({
        vaultRoot: '/vault',
        relPath: 'b.md',
        frontmatter: {},
        body: 'b',
        callerId: 'b',
      });

      vi.useRealTimers();
      await flushMarkdownWrite('a');

      const writes = invokes.filter((i) => i.channel === 'vault:write-existing-file-text');
      expect(writes).toHaveLength(1);
      expect(writes[0].args[1]).toBe('a.md');
      // 'b' is still queued — it'll only fire when its timer elapses or is flushed.
      await flushMarkdownWrite('b');
      const writes2 = invokes.filter((i) => i.channel === 'vault:write-existing-file-text');
      expect(writes2.map((w) => w.args[1])).toEqual(['a.md', 'b.md']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelAllMarkdownWrites drains every caller (pending timers cleared, no writes issued)', async () => {
    vi.useFakeTimers();
    try {
      markHydrated('a.md', false);
      markHydrated('b.md', false);
      markHydrated('c.md', false);

      scheduleMarkdownWrite({
        vaultRoot: '/vault',
        relPath: 'a.md',
        frontmatter: {},
        body: 'a',
        callerId: 'a',
      });
      scheduleMarkdownWrite({
        vaultRoot: '/vault',
        relPath: 'b.md',
        frontmatter: {},
        body: 'b',
        callerId: 'b',
      });
      scheduleMarkdownWrite({
        vaultRoot: '/vault',
        relPath: 'c.md',
        frontmatter: {},
        body: 'c',
        callerId: 'c',
      });

      cancelAllMarkdownWrites();
      // After cancel, hydration is also cleared.
      expect(isHydrated('a.md')).toBe(false);
      expect(isHydrated('b.md')).toBe(false);
      expect(isHydrated('c.md')).toBe(false);

      // Run any remaining timers — none should fire writes since cancel
      // cleared the pending map.
      vi.runAllTimers();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 0));

      const writes = invokes.filter((i) => i.channel === 'vault:write-existing-file-text');
      expect(writes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('vault-swap pre-swap hook clears gateway state', async () => {
    vi.useFakeTimers();
    try {
      markHydrated('a.md', true);
      scheduleMarkdownWrite({
        vaultRoot: '/vault-A',
        relPath: 'a.md',
        frontmatter: {},
        body: 'armed against vault A',
        callerId: 'pre-swap-caller',
      });

      expect(isHydrated('a.md')).toBe(true);

      vi.useRealTimers();
      // Firing pre-swap should invoke the gateway's registered handler.
      await fireVaultSwap({
        phase: 'pre-swap',
        previousVault: '/vault-A',
        nextVault: '/vault-B',
        saveOutgoing: false,
      });

      // Hydration cleared. Pending timers cancelled.
      expect(isHydrated('a.md')).toBe(false);

      // Even if the timer had fired before swap, no IPC was made (cancelled).
      vi.useFakeTimers();
      vi.runAllTimers();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 0));
      const writes = invokes.filter((i) => i.channel === 'vault:write-existing-file-text');
      expect(writes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushAllMarkdownWrites surfaces per-caller failures by callerId', async () => {
    // Override the stub so vault:write-existing-file-text rejects.
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string) => {
        if (channel === 'vault:write-existing-file-text') {
          throw new Error('boom');
        }
        return { success: true };
      },
      on: () => () => {},
      send: () => {},
    };

    markHydrated('failing.md', false);
    vi.useFakeTimers();
    scheduleMarkdownWrite({
      vaultRoot: '/vault',
      relPath: 'failing.md',
      frontmatter: {},
      body: 'x',
      callerId: 'failing-caller',
    });
    vi.useRealTimers();

    const result = await flushAllMarkdownWrites();
    expect(result.ok).toBe(false);
    expect(result.failed).toContain('failing-caller');
  });

  it('registerForceWriter + forceWriteForDocument fires the build callback', async () => {
    const relPath = 'forced.md';
    markHydrated(relPath, false);

    let calls = 0;
    registerForceWriter('force-test', 'doc-A', (): WriteArgs => {
      calls++;
      return {
        vaultRoot: '/vault',
        relPath,
        frontmatter: { forced: true },
        body: 'live body',
        callerId: 'force-test',
        docId: 'doc-A',
      };
    });

    const result = await forceWriteForDocument('doc-A');
    expect(calls).toBe(1);
    expect(result.ok).toBe(1);
    expect(result.failed).toEqual([]);

    // The write landed on disk via the gateway.
    const writes = invokes.filter((i) => i.channel === 'vault:write-existing-file-text');
    expect(writes).toHaveLength(1);
    expect((writes[0].args[2] as string)).toContain('forced: true');
    expect((writes[0].args[2] as string)).toContain('live body');
  });

  it('forceWriteForDocument skips writers whose docId does not match', async () => {
    markHydrated('a.md', false);
    registerForceWriter('writer-A', 'doc-A', () => ({
      vaultRoot: '/vault',
      relPath: 'a.md',
      frontmatter: {},
      body: 'a-body',
      callerId: 'writer-A',
      docId: 'doc-A',
    }));

    const result = await forceWriteForDocument('doc-OTHER');
    expect(result.ok).toBe(0);
    expect(result.failed).toEqual([]);
    expect(invokes.filter((i) => i.channel === 'vault:write-existing-file-text')).toHaveLength(0);
  });

  it('refreshes vaultIndex from the just-written bytes (Sprint C / C-A5-2)', async () => {
    // Wipe any prior index state so the assertion can't false-pass on a
    // leftover entry from a previous test in this suite.
    vaultIndexStore.clear();
    const relPath = 'Notes/refresh.md';
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { tags: ['after-write'], status: 'done' },
      body: 'Post-write body.',
      callerId: 'refresh-caller',
      docId: null,
    });

    // The index now reflects the just-written content. A late watcher echo
    // past the renderer suppression TTL would land here, capture this
    // metadata as `previousMetadata`, then have applyChanges re-read the
    // (identical) disk content and classify the diff as noop-change — no
    // spurious "modified externally" toast.
    const metadata = vaultIndexStore.getMetadata(relPath);
    expect(metadata).not.toBeNull();
    // The gateway's assembleMarkdownFile appends a trailing newline so
    // the file ends with LF — match that here.
    expect(metadata!.content.trim()).toBe('Post-write body.');
    expect(metadata!.tags).toContain('after-write');
    expect(metadata!.frontmatter.status).toBe('done');
  });
});

// 6.4.M2 — when the post-write `vault:stat` fails or returns a stat without
// finite mtime/size (AV scanner / SMB latency / VFS quirks), the prior
// implementation swallowed the error and left the PRE-write baseline in
// place. Next reconcile compared post-write disk bytes against the
// pre-write baseline and surfaced a spurious "modified externally" toast.
//
// The fix: clear the baseline on stat failure / unusable stat — the
// "no baseline" path is benign (writers proceed without drift check
// until the next successful hydrate or write seeds a fresh baseline).
describe('markdownFileWriter — post-write baseline failures (M2)', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async () => undefined,
      on: () => () => {},
      send: () => {},
    };
  });

  it('clears stale baseline when post-write vault:stat throws', async () => {
    const relPath = 'Notes/baselineThrow.md';

    // Pre-stamp the baseline at the PRE-write state.
    noteBaseline(relPath, 100, 10);
    expect(getBaseline(relPath)).toEqual({ mtimeMs: 100, size: 10 });

    markHydrated(relPath, false);

    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string) => {
        if (channel === 'vault:write-existing-file-text') {
          return { success: true };
        }
        if (channel === 'vault:stat') {
          // AV / SMB transient — stat throws after a successful write.
          return { success: false, error: 'ENOENT (transient)' };
        }
        return { success: true, ok: true };
      },
      on: () => () => {},
      send: () => {},
    };

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'New body',
      callerId: 'baseline-throw',
      docId: null,
    });

    // Bug: baseline still 100/10 — next reconcile flags this file as
    // "modified externally". Fix: baseline is cleared (undefined) so the
    // next hydrate or successful write seeds a fresh value.
    expect(getBaseline(relPath)).toBeUndefined();
  });

  it('clears stale baseline when post-write vault:stat returns unusable mtime/size', async () => {
    const relPath = 'Notes/baselineMissing.md';

    noteBaseline(relPath, 200, 20);
    expect(getBaseline(relPath)).toEqual({ mtimeMs: 200, size: 20 });

    markHydrated(relPath, false);

    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string) => {
        if (channel === 'vault:write-existing-file-text') {
          return { success: true };
        }
        if (channel === 'vault:stat') {
          // Some VFS layers return success without mtime/size (or NaN).
          // noteBaseline early-outs on undefined — the prior code then
          // left the stale baseline. Fix: clear instead.
          return { success: true, mtimeMs: undefined, size: undefined };
        }
        return { success: true, ok: true };
      },
      on: () => () => {},
      send: () => {},
    };

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'Body 2',
      callerId: 'baseline-missing',
      docId: null,
    });

    expect(getBaseline(relPath)).toBeUndefined();
  });
});

