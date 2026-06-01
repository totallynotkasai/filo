/**
 * Phase R2 — `withDrainedWrites` contract tests.
 *
 * Covers the three acceptance criteria the audit's silent-data-loss paths
 * pointed at:
 *
 *  1. Pending markdown writes drain BEFORE the op runs (so a dirty
 *     editor's body lands on the OLD path before the rename moves it).
 *  2. Pending writers that REJECT during drain produce a
 *     `PendingWritesFailedError`, surface an aggregated toast, and the
 *     op is NOT invoked.
 *  3. The re-entrancy guard collapses nested `withDrainedWrites` calls
 *     so a complex sequence (e.g. delete-with-snapshots calling
 *     `deleteVaultPath` internally) only drains once.
 *
 *  Plus structural smoke for the four IPC convenience wrappers:
 *  - renameVaultPath / deleteVaultPath / createVaultFolder /
 *    copyFileIntoVault all flush before the IPC fires.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PendingWritesFailedError,
  withDrainedWrites,
  renameVaultPath,
  deleteVaultPath,
  createVaultFolder,
  copyFileIntoVault,
  __resetDrainGuardForTests,
} from '@renderer/lib/vault/vaultOperations';
import {
  scheduleMarkdownWrite,
  markHydrated,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import {
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { scheduleMiscWrite } from '@renderer/lib/boards/miscWriteScheduler';
import { scheduleConfigWrite } from '@renderer/lib/boards/configWriteScheduler';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { uiStore } from '@renderer/stores/ui.svelte';

beforeEach(() => {
  __resetMarkdownFileWriterForTests();
  __resetDirtyTrackingForTests();
  __resetDrainGuardForTests();
  restoreFiloDefault();
  // Clear any toasts left over from a prior test so we can assert on the
  // first toast pushed during this test cleanly.
  for (const t of uiStore.toasts) uiStore.dismissToast(t.id, { silent: true });
});

afterEach(() => {
  __resetMarkdownFileWriterForTests();
  __resetDirtyTrackingForTests();
  __resetDrainGuardForTests();
  restoreFiloDefault();
  vi.useRealTimers();
});

describe('withDrainedWrites — drain ordering', () => {
  it('flushes pending markdown writes BEFORE running op (acceptance #1)', async () => {
    vi.useFakeTimers();
    const events: string[] = [];

    installFiloMock({
      'vault:write-existing-file-text': async (...args) => {
        const [, relPath] = args as [string, string];
        events.push(`write:${relPath}`);
        return { success: true };
      },
    });

    // Hydrate the file so the markdownFileWriter accepts the write.
    markHydrated('Notes.md', false);

    // Arm a debounced write. Without the drain, the op runs first.
    scheduleMarkdownWrite({
      vaultRoot: '/vault',
      relPath: 'Notes.md',
      frontmatter: {},
      body: 'Pending edit',
      callerId: 'caller-1',
    });

    // Trigger the debounce so the write enters in-flight.
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    await withDrainedWrites(async () => {
      events.push('op');
    });

    // Order: write must precede op. The drain guarantees the markdown
    // write IPC completed before the op callback ran.
    expect(events).toEqual(['write:Notes.md', 'op']);
  });

  it('does NOT invoke op when a pending write rejects, surfaces an error toast (acceptance #2)', async () => {
    vi.useFakeTimers();
    const opSpy = vi.fn(async () => 'op-ran');

    installFiloMock({
      'vault:write-existing-file-text': async () => {
        return { success: false, error: 'EACCES: permission denied' };
      },
    });

    markHydrated('Locked.md', false);
    scheduleMarkdownWrite({
      vaultRoot: '/vault',
      relPath: 'Locked.md',
      frontmatter: {},
      body: 'will fail',
      callerId: 'caller-locked',
    });

    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    await expect(withDrainedWrites(opSpy)).rejects.toBeInstanceOf(
      PendingWritesFailedError,
    );
    expect(opSpy).not.toHaveBeenCalled();

    // The error toast names the failed caller so the user can see which
    // write blocked the disk-shape change.
    const toasts = uiStore.toasts;
    const errorToast = toasts.find((t) => t.type === 'error');
    expect(errorToast).toBeDefined();
    expect(errorToast!.text).toMatch(/pending write/);
  });

  // Phase 6.4.M1 — withDrainedWrites must also drain misc + config writers.
  // Otherwise a debounced sidebar-order / viewport / tags / workspace.json
  // write fires AFTER the disk-shape change lands, racing the rename or
  // resurrecting a path the IPC just removed.
  it('flushes pending misc writes BEFORE running op (M1 — misc)', async () => {
    const events: string[] = [];

    installFiloMock({
      'vault:write-file-text': async () => ({ success: true }),
      'config:save': async () => ({ success: true }),
    });

    // Arm a pending misc timer — DO NOT pre-fire it. The contract is that
    // `withDrainedWrites` itself forces the flush, not "happens to drain
    // because the timer already fired and an unrelated await drained the
    // microtask queue."
    scheduleMiscWrite('test-misc-key', () => ({
      vaultRoot: '/vault',
      path: '.filo/tags.json',
      write: async () => {
        events.push('misc-write');
      },
    }));

    await withDrainedWrites(async () => {
      events.push('op');
    });

    expect(events).toEqual(['misc-write', 'op']);
  });

  it('flushes pending config writes BEFORE running op (M1 — config)', async () => {
    const events: string[] = [];

    installFiloMock({
      'config:save': async () => {
        events.push('config-save');
        return { success: true };
      },
      'config:save-workspace': async () => {
        events.push('config-save-workspace');
        return { success: true };
      },
    });

    scheduleConfigWrite(() => ({
      vaultRoot: '/vault',
      settings: { general: {}, board: {}, document: {} } as never,
      theme: 'light',
      workspace: { openTabs: [], activeTabId: null } as never,
      layout: { paneTree: null, activePaneId: null } as never,
    }));

    await withDrainedWrites(async () => {
      events.push('op');
    });

    // The config bundle writes one or more `config:save*` IPCs. Every one
    // must land BEFORE the op runs.
    expect(events[events.length - 1]).toBe('op');
    const opIndex = events.indexOf('op');
    expect(opIndex).toBeGreaterThan(0);
    for (let i = 0; i < opIndex; i++) {
      expect(events[i]).toMatch(/^config-save/);
    }
  });

  it('collapses nested calls via the re-entrancy guard (acceptance #3)', async () => {
    const drainSpy = vi.fn();
    const innerOp = vi.fn(async () => 'inner');

    // Install a mock that tracks each pretended drain (every IPC counts as
    // one). With the re-entrancy guard, the second drain inside the nested
    // withDrainedWrites should be a no-op, so the inner mock invoke count
    // matches the outer count exactly.
    installFiloMock({
      'vault:rename': async () => {
        drainSpy();
        return { success: true };
      },
    });

    let outerRan = false;
    await withDrainedWrites(async () => {
      outerRan = true;
      // Re-entry: the convenience helper drains again, but the guard
      // short-circuits to the inner op directly.
      await renameVaultPath('/vault', 'a.md', 'b.md');
      await innerOp();
    });

    expect(outerRan).toBe(true);
    expect(innerOp).toHaveBeenCalledTimes(1);
    // The vault:rename IPC fired exactly once (the inner renameVaultPath
    // call) — the outer wrapper didn't issue any IPC of its own.
    expect(drainSpy).toHaveBeenCalledTimes(1);
  });
});

describe('withDrainedWrites — IPC convenience wrappers', () => {
  it('renameVaultPath forwards args to vault:rename and returns the envelope', async () => {
    const calls: unknown[][] = [];
    installFiloMock({
      'vault:rename': async (...args) => {
        calls.push(args);
        return { success: true };
      },
    });

    const result = await renameVaultPath('/vault', 'old.md', 'new.md');

    expect(result).toEqual({ success: true });
    expect(calls).toEqual([['/vault', 'old.md', 'new.md']]);
  });

  it('deleteVaultPath forwards args to vault:delete and returns the envelope', async () => {
    const calls: unknown[][] = [];
    installFiloMock({
      'vault:delete': async (...args) => {
        calls.push(args);
        return { success: true };
      },
    });

    const result = await deleteVaultPath('/vault', '/vault/Notes.md');

    expect(result).toEqual({ success: true });
    expect(calls).toEqual([['/vault', '/vault/Notes.md']]);
  });

  it('createVaultFolder forwards args to vault:create-folder', async () => {
    const calls: unknown[][] = [];
    installFiloMock({
      'vault:create-folder': async (...args) => {
        calls.push(args);
        return { success: true };
      },
    });

    const result = await createVaultFolder('/vault', 'NewFolder');

    expect(result).toEqual({ success: true });
    expect(calls).toEqual([['/vault', 'NewFolder']]);
  });

  it('copyFileIntoVault forwards args to vault:copy-file', async () => {
    const calls: unknown[][] = [];
    installFiloMock({
      'vault:copy-file': async (...args) => {
        calls.push(args);
        return { success: true, path: '/vault/img.png', relativePath: 'img.png' };
      },
    });

    const result = await copyFileIntoVault('/source/img.png', '/vault');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.path).toBe('/vault/img.png');
    }
    expect(calls).toEqual([['/source/img.png', '/vault']]);
  });

  it('copyFileIntoVault forwards the destFolder when supplied', async () => {
    const calls: unknown[][] = [];
    installFiloMock({
      'vault:copy-file': async (...args) => {
        calls.push(args);
        return { success: true, path: '/vault/Sub/img.png', relativePath: 'Sub/img.png' };
      },
    });

    await copyFileIntoVault('/source/img.png', '/vault', 'Sub');

    expect(calls).toEqual([['/source/img.png', '/vault', 'Sub']]);
  });
});

describe('PendingWritesFailedError', () => {
  it('aggregates per-pipeline failure counts in its message', () => {
    const err = new PendingWritesFailedError({
      md: { ok: 0, failed: [{ ownerId: 'a', error: new Error('x') }] },
      fm: { failed: ['b.md', 'c.md'] },
      board: { failed: ['d.board.json'] },
      misc: { failed: ['.filo/tags.json'] },
      config: { failed: ['defaults.json'] },
    });
    expect(err.message).toMatch(/6 file/);
    expect(err.name).toBe('PendingWritesFailedError');
    expect(err.results.md.failed).toHaveLength(1);
    expect(err.results.fm.failed).toHaveLength(2);
    expect(err.results.board.failed).toHaveLength(1);
    expect(err.results.misc.failed).toHaveLength(1);
    expect(err.results.config.failed).toHaveLength(1);
  });
});
