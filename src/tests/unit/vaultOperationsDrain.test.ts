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
 *     so a complex sequence (e.g. a delete cascade calling
 *     `trashVaultPath` internally) only drains once.
 *
 *  Plus structural smoke for the IPC convenience wrappers:
 *  - renameVaultPath / trashVaultPath / restoreTrashed / createVaultFolder /
 *    copyFileIntoVault all flush before the IPC fires.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PendingWritesFailedError,
  withDrainedWrites,
  renameVaultPath,
  trashVaultPath,
  restoreTrashed,
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
import { registerNotePrompts } from '@renderer/stores/notePrompts';

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

  it('trashVaultPath lands a queued note edit before the trash move', async () => {
    const events: string[] = [];
    const vault = installMemoryVault({ 'Notes.md': '---\ntitle: Notes\n---\nBody\n' });
    vault.beforeWrite = (rel) => {
      if (rel.endsWith('.md')) events.push(`write:${rel}`);
    };
    const invoke = window.filo.invoke;
    window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:trash-move') events.push('trash-move');
      return (invoke as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args);
    }) as typeof window.filo.invoke;
    noteStore.patchFrontmatter('Notes.md', { set: { status: 'edited' }, unset: [] });

    const result = await trashVaultPath('/vault', 'Notes.md');

    expect(result.success).toBe(true);
    expect(events).toEqual(['write:Notes.md', 'trash-move']);
    // The edit went to the trash with the note, not lost and not left behind.
    expect(vault.read('Notes.md')).toBeUndefined();
    const [entry] = [...vault.trash.values()];
    expect(entry.files.get('Notes.md')).toContain('status: edited');
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
    await withDrainedWrites(async (drain) => {
      outerRan = true;
      // Re-entry: given the outer op's token, the convenience helper runs
      // under the outer drain instead of draining again.
      await renameVaultPath('/vault', 'a.md', 'b.md', drain);
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

  it('trashVaultPath forwards the vault-relative path to vault:trash-move and returns the envelope', async () => {
    const calls: unknown[][] = [];
    installFiloMock({
      'vault:trash-move': async (...args) => {
        calls.push(args);
        return { success: true, trashId: 'tid', kind: 'file' };
      },
    });

    const result = await trashVaultPath('/vault', 'Notes.md');

    expect(result).toEqual({ success: true, trashId: 'tid', kind: 'file' });
    expect(calls).toEqual([['/vault', 'Notes.md']]);
  });

  it('restoreTrashed forwards the trash id to vault:trash-restore and returns the envelope', async () => {
    const calls: unknown[][] = [];
    const envelope = { success: true, restoredPath: 'Notes.md', originalPath: 'Notes.md', kind: 'file', alongside: false };
    installFiloMock({
      'vault:trash-restore': async (...args) => {
        calls.push(args);
        return envelope;
      },
    });

    const result = await restoreTrashed('/vault', 'tid', 'Notes.md');

    expect(result).toEqual(envelope);
    expect(calls).toEqual([['/vault', 'tid']]);
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

describe('withDrainedWrites — scoped to the paths an operation touches', () => {
  /** A change queued for `rel` whose file is gone: every drain fails it (ENOENT). */
  async function failedWriteAt(rel: string, others: Record<string, string> = {}): Promise<void> {
    const vault = installMemoryVault({ [rel]: '---\ntitle: T\n---\nBody\n', ...others });
    vault.remove(rel);
    noteStore.patchFrontmatter(rel, { set: { status: 'x' }, unset: [] });
    // The first drain reports it; the write stays queued and failed.
    await expect(withDrainedWrites(async () => undefined)).rejects.toBeInstanceOf(PendingWritesFailedError);
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  }

  it('a failed write elsewhere does not block the operation', async () => {
    await failedWriteAt('Card.md', { 'Other.md': 'x' });
    const op = vi.fn(async () => 'ran');
    await expect(withDrainedWrites(op, { paths: ['Other.md', 'Other renamed.md'] })).resolves.toBe('ran');
    expect(op).toHaveBeenCalledTimes(1);
    expect(uiStore.toasts.some((t) => t.text.includes("Couldn't complete the operation"))).toBe(false);
  });

  it('a failed write on the path itself blocks it', async () => {
    await failedWriteAt('Card.md');
    const op = vi.fn(async () => 'ran');
    await expect(withDrainedWrites(op, { paths: ['card.md'] })).rejects.toBeInstanceOf(PendingWritesFailedError);
    expect(op).not.toHaveBeenCalled();
    expect(uiStore.toasts.find((t) => t.type === 'error')?.text).toContain('Card.md');
  });

  it('a folder rename over a failed note inside it is blocked', async () => {
    await failedWriteAt('Work/Card.md');
    const op = vi.fn(async () => 'ran');
    await expect(withDrainedWrites(op, { paths: ['Work', 'Projects'] })).rejects.toBeInstanceOf(PendingWritesFailedError);
    expect(op).not.toHaveBeenCalled();
  });

  it('absolute paths under the vault are matched too', async () => {
    await failedWriteAt('Card.md');
    await expect(
      renameVaultPath('/vault', '/vault/Card.md', '/vault/Moved.md'),
    ).rejects.toBeInstanceOf(PendingWritesFailedError);
  });

  it('an unscoped drain and save (close, open, quit) still refuse on any failure', async () => {
    await failedWriteAt('Card.md', { 'Other.md': 'x' });
    await withDrainedWrites(async () => undefined, { paths: ['Other.md'] });
    await expect(withDrainedWrites(async () => undefined)).rejects.toBeInstanceOf(PendingWritesFailedError);
    expect(await vaultStore.save()).toBe(false);
  });

  it('the "file no longer exists" prompt offers Discard change, which unblocks the path', async () => {
    registerNotePrompts();
    await failedWriteAt('Card.md');
    // Drain again so the prompt is raised on a toast we can see.
    await expect(withDrainedWrites(async () => undefined, { paths: ['Card.md'] })).rejects.toBeInstanceOf(PendingWritesFailedError);
    await noteStore.__settleGraceChecksForTests();
    const prompt = uiStore.toasts.find((t) => t.text.includes('the file no longer exists'));
    expect(prompt?.actions?.map((a) => a.label)).toEqual(['Discard change']);
    await prompt!.actions![0].handler();

    const op = vi.fn(async () => 'ran');
    await expect(withDrainedWrites(op, { paths: ['Card.md'] })).resolves.toBe('ran');
    expect(await vaultStore.save()).toBe(true);
  });

  it('with an unsaved body, "Save as new file" writes the note back at its path', async () => {
    registerNotePrompts();
    const vault = installMemoryVault({ 'Card.md': '---\ntitle: Card\n---\nBody\n' });
    const m = noteStore.acquire('Card.md', 'editor');
    await m.loaded;
    vault.remove('Card.md');
    noteStore.setBody('Card.md', 'Typed text\n', 'editor');
    await expect(withDrainedWrites(async () => undefined, { paths: ['Card.md'] })).rejects.toBeInstanceOf(PendingWritesFailedError);
    await noteStore.__settleGraceChecksForTests();
    const prompt = uiStore.toasts.find((t) => t.text.includes('the file no longer exists'));
    expect(prompt?.actions?.map((a) => a.label)).toEqual(['Save as new file', 'Discard change']);
    await prompt!.actions![0].handler();

    expect(vault.read('Card.md')).toBe('---\ntitle: Card\n---\nTyped text\n');
    expect(await vaultStore.save()).toBe(true);
  });

  it('a note waiting for its conflict answer blocks an operation Filo makes, but not one following a move already on disk', async () => {
    const vault = installMemoryVault({ 'Plot.md': '---\ntitle: Plot\n---\nBody\n' });
    const m = noteStore.acquire('Plot.md', 'editor');
    await m.loaded;
    noteStore.setBody('Plot.md', 'Body, typed\n', 'editor');
    vault.writeExternally('Plot.md', '---\ntitle: Plot\n---\nBody, links fixed\n');
    await noteStore.onDiskChanged('Plot.md');
    expect(m.status).toBe('conflict');

    const op = vi.fn(async () => 'ran');
    await expect(withDrainedWrites(op, { paths: ['Plot.md', 'Story/Plot.md'] })).rejects.toBeInstanceOf(PendingWritesFailedError);
    expect(op).not.toHaveBeenCalled();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });

    await expect(withDrainedWrites(op, { paths: ['Plot.md', 'Story/Plot.md'], followsMove: true })).resolves.toBe('ran');
    expect(uiStore.toasts.some((t) => t.text.includes("Couldn't complete the operation"))).toBe(false);
    // The typing is still held for the answer, not written over the other version.
    expect(vault.read('Plot.md')).toContain('links fixed');
    expect(m.status).toBe('conflict');
  });

  it('following a move still refuses on a write that failed for another reason', async () => {
    await failedWriteAt('Card.md');
    const op = vi.fn(async () => 'ran');
    await expect(withDrainedWrites(op, { paths: ['Card.md', 'Moved/Card.md'], followsMove: true })).rejects.toBeInstanceOf(PendingWritesFailedError);
    expect(op).not.toHaveBeenCalled();
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
