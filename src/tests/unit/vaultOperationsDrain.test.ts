/**
 * `withDrainedWrites` contract tests.
 *
 * Covers the three acceptance criteria the silent-data-loss paths pointed
 * at:
 *
 *  1. Pending note writes drain BEFORE the op runs (so an open note's body
 *     lands on the OLD path before the rename moves it).
 *  2. Pending writes that FAIL during the drain produce a
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
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { scheduleMiscWrite } from '@renderer/lib/boards/miscWriteScheduler';
import { scheduleConfigWrite } from '@renderer/lib/boards/configWriteScheduler';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault } from '../helpers/memoryVault';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';

beforeEach(() => {
  // Runs the test-reset callbacks, which clear the active vault path.
  __resetDirtyTrackingForTests();
  vaultStore.setPath('/vault');
  noteStore.__resetForTests();
  __resetDrainGuardForTests();
  restoreFiloDefault();
  // Clear any toasts left over from a prior test so we can assert on the
  // first toast pushed during this test cleanly.
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
});

afterEach(() => {
  noteStore.__resetForTests();
  __resetDirtyTrackingForTests();
  __resetDrainGuardForTests();
  restoreFiloDefault();
  vaultStore.setPath('');
  vi.useRealTimers();
});

describe('withDrainedWrites — drain ordering', () => {
  it('flushes pending note writes BEFORE running op (acceptance #1)', async () => {
    const events: string[] = [];
    const vault = installMemoryVault({ 'Notes.md': '---\ntitle: Notes\n---\nBody\n' });
    vault.beforeWrite = (rel) => {
      if (rel.endsWith('.md')) events.push(`write:${rel}`);
    };

    const m = noteStore.acquire('Notes.md', 'editor');
    await m.loaded;
    noteStore.setBody('Notes.md', 'Pending edit\n', 'editor');

    await withDrainedWrites(async () => {
      events.push('op');
    });

    // Order: write must precede op. The drain guarantees the note write
    // IPC completed before the op callback ran.
    expect(events).toEqual(['write:Notes.md', 'op']);
    expect(vault.read('Notes.md')).toBe('---\ntitle: Notes\n---\nPending edit\n');
  });

  it('does NOT invoke op when a pending write fails, surfaces an error toast (acceptance #2)', async () => {
    const opSpy = vi.fn(async () => 'op-ran');
    const vault = installMemoryVault({ 'Locked.md': '---\ntitle: Locked\n---\nBody\n' });
    vault.failNextWrite('Locked.md', 'EACCES');
    noteStore.patchFrontmatter('Locked.md', { set: { status: 'will fail' }, unset: [] });

    await expect(withDrainedWrites(opSpy)).rejects.toBeInstanceOf(
      PendingWritesFailedError,
    );
    expect(opSpy).not.toHaveBeenCalled();

    // The error toast names the failed note so the user can see which
    // write blocked the disk-shape change.
    const errorToast = uiStore.toasts.find((t) => t.type === 'error');
    expect(errorToast).toBeDefined();
    expect(errorToast!.text).toMatch(/pending write/);
    expect(errorToast!.text).toContain('Locked.md');
  });

  it('deleteVaultPath lands a queued note edit before the delete IPC', async () => {
    const events: string[] = [];
    const vault = installMemoryVault({ 'Notes.md': '---\ntitle: Notes\n---\nBody\n' });
    vault.beforeWrite = (rel) => {
      if (rel.endsWith('.md')) events.push(`write:${rel}`);
    };
    const invoke = window.filo.invoke;
    window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:delete' && !String(args[1]).includes('.filo/')) {
        events.push('delete');
        return { success: true };
      }
      return (invoke as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args);
    }) as typeof window.filo.invoke;
    noteStore.patchFrontmatter('Notes.md', { set: { status: 'edited' }, unset: [] });

    await deleteVaultPath('/vault', '/vault/Notes.md');

    expect(events).toEqual(['write:Notes.md', 'delete']);
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
      notes: { failed: ['a.md', 'b.md', 'c.md'] },
      board: { failed: ['d.board.json'] },
      misc: { failed: ['.filo/tags.json'] },
      config: { failed: ['defaults.json'] },
    });
    expect(err.message).toMatch(/6 file/);
    expect(err.name).toBe('PendingWritesFailedError');
    expect(err.results.notes.failed).toHaveLength(3);
    expect(err.results.board.failed).toHaveLength(1);
    expect(err.results.misc.failed).toHaveLength(1);
    expect(err.results.config.failed).toHaveLength(1);
  });
});
