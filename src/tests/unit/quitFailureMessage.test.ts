import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFlushAndQuit, __resetQuitDrainingForTests } from '@renderer/lib/vault/handleFlushAndQuit';
import {
  leaveVaultDialog,
  quitFailureBody,
  rescueFailedDialog,
  rescueKeptText,
  type UnsavedItem,
} from '@renderer/lib/vault/unsavedMessages';
import { uiStore } from '@renderer/stores/ui.svelte';

const handshakeOf = (sent: readonly string[]): string[] => sent.filter((c) => c !== 'app:drain-heartbeat');
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('quit "Save failed" message by cause', () => {
  it('a locked file: names it and says another program may hold it', () => {
    const body = quitFailureBody([{ path: 'Notes/A.md', cause: 'write-failed' }], 0);
    expect(body).toContain('1 change couldn\'t be saved');
    expect(body).toContain('Notes/A.md');
    expect(body).toContain('OneDrive or antivirus');
    expect(body).toContain('Retry now');
  });

  it('a missing file: says it no longer exists, and nothing about a lock or .tmp', () => {
    const body = quitFailureBody([{ path: 'Gone.md', cause: 'missing' }], 0);
    expect(body).toContain('Gone.md: the file no longer exists');
    expect(body).not.toContain('OneDrive');
    expect(body).not.toContain('.tmp');
  });

  it('a held conflict: says it waits for an answer', () => {
    const body = quitFailureBody([{ path: 'C.md', cause: 'conflict' }], 0);
    expect(body).toContain('waiting for your answer');
    expect(body).toContain('changed by another program');
  });

  it('a note that is not UTF-8', () => {
    const body = quitFailureBody([{ path: 'Old.md', cause: 'non-utf8' }], 0);
    expect(body).toContain("isn't UTF-8");
  });

  it('mentions .tmp files only when a failed write preserved some', () => {
    const items: UnsavedItem[] = [{ path: 'A.md', cause: 'write-failed' }];
    expect(quitFailureBody(items, 0)).not.toContain('.tmp');
    expect(quitFailureBody(items, 2)).toContain('2 partial .tmp files');
  });

  it('always says where "Quit anyway" keeps the copies', () => {
    expect(quitFailureBody([], 0)).toContain('.filo/recovery');
    expect(quitFailureBody([{ path: 'A.md', cause: 'missing' }], 0)).toContain('.filo/recovery');
  });

  it('lists at most six paths', () => {
    const items = Array.from({ length: 9 }, (_, i): UnsavedItem => ({ path: `N${i}.md`, cause: 'missing' }));
    const body = quitFailureBody(items, 0);
    expect(body).toContain('N5.md');
    expect(body).not.toContain('N6.md');
    expect(body).toContain('…and 3 more');
  });
});

describe('close / open-another-vault dialog text', () => {
  it('names the files and offers only "Close anyway" / Cancel wording', () => {
    const d = leaveVaultDialog([{ path: 'A.md', cause: 'missing' }], 'close');
    expect(d.anyway).toBe('Close anyway');
    expect(d.message).toBe("1 change couldn't be saved.");
    expect(d.detail).toContain('A.md: the file no longer exists');
    expect(d.detail).toContain('.filo/recovery');
    expect(`${d.message}${d.detail}`).not.toContain("Don't Save");
  });

  it('opening another vault says "Open anyway"', () => {
    expect(leaveVaultDialog([{ path: 'A.md', cause: 'pending' }], 'open').anyway).toBe('Open anyway');
  });

  it('a copy that could not be kept is named, and going ahead says it is lost', () => {
    const d = rescueFailedDialog(['A.md'], 'Close anyway');
    expect(d.detail).toContain('A.md');
    expect(d.detail).toContain('lost');
    expect(d.anyway).toBe('Close anyway and lose it');
  });

  it('the after-close toast names the folder', () => {
    expect(rescueKeptText({ dir: '.filo/recovery/x-unsaved', kept: ['A.md'], notKept: [] })).toBe(
      '1 unsaved change was kept in .filo/recovery/x-unsaved.',
    );
    expect(rescueKeptText({ dir: null, kept: [], notKept: ['A.md'] })).toBeNull();
  });
});

describe('handleFlushAndQuit — worded by cause, rescue copies before "Quit anyway"', () => {
  beforeEach(() => {
    __resetQuitDrainingForTests();
    uiStore.closeConfirm();
  });
  afterEach(() => {
    __resetQuitDrainingForTests();
    uiStore.closeConfirm();
  });

  it('the dialog body comes from the unsaved causes and the .tmp count', async () => {
    const sent: string[] = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => { sent.push(c); },
      reportError: () => {},
      describeUnsaved: async () => [{ path: 'Gone.md', cause: 'missing' }],
      preservedTmpCount: async () => 0,
    });
    await tick();
    const body = uiStore.confirmDialog?.body ?? '';
    expect(body).toContain('Gone.md: the file no longer exists');
    expect(body).not.toContain('.tmp');
    uiStore.confirmDialog!.onCancel?.();
    uiStore.closeConfirm();
    await promise;
    expect(handshakeOf(sent)).toEqual(['app:quit-awaiting-user', 'app:cancel-quit']);
  });

  it('"Quit anyway" keeps rescue copies before ready-to-quit', async () => {
    const order: string[] = [];
    const keepRescueCopies = vi.fn(async () => {
      order.push('rescue');
      return { dir: '.filo/recovery/x-unsaved', kept: ['Gone.md'], notKept: [] };
    });
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => { if (c !== 'app:drain-heartbeat') order.push(c); },
      reportError: () => {},
      describeUnsaved: async () => [{ path: 'Gone.md', cause: 'missing' }],
      keepRescueCopies,
    });
    await tick();
    uiStore.confirmDialog!.onConfirm(false);
    uiStore.closeConfirm();
    await promise;
    expect(keepRescueCopies).toHaveBeenCalledOnce();
    expect(order).toEqual(['app:quit-awaiting-user', 'rescue', 'app:ready-to-quit']);
  });

  it('a copy that could not be written asks again; "Stay open" cancels the quit', async () => {
    const sent: string[] = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => { sent.push(c); },
      reportError: () => {},
      describeUnsaved: async () => [{ path: 'Big.md', cause: 'write-failed' }],
      keepRescueCopies: async () => ({ dir: null, kept: [], notKept: ['Big.md'] }),
    });
    await tick();
    uiStore.confirmDialog!.onConfirm(false);
    uiStore.closeConfirm();
    await tick();
    expect(uiStore.confirmDialog?.body).toContain('Big.md');
    expect(uiStore.confirmDialog?.confirmLabel).toBe('Quit anyway and lose it');
    uiStore.confirmDialog!.onCancel?.();
    uiStore.closeConfirm();
    await promise;
    expect(handshakeOf(sent)).toEqual(['app:quit-awaiting-user', 'app:cancel-quit']);
  });

  it('a rescue that throws is treated as not kept, and the user decides', async () => {
    const sent: string[] = [];
    const promise = handleFlushAndQuit({
      saveStateState: () => 'idle',
      save: async () => false,
      send: (c) => { sent.push(c); },
      reportError: () => {},
      keepRescueCopies: async () => { throw new Error('disk gone'); },
    });
    await tick();
    uiStore.confirmDialog!.onConfirm(false);
    uiStore.closeConfirm();
    await tick();
    expect(uiStore.confirmDialog?.confirmLabel).toBe('Quit anyway and lose it');
    uiStore.confirmDialog!.onConfirm(false);
    uiStore.closeConfirm();
    await promise;
    expect(handshakeOf(sent)).toEqual(['app:quit-awaiting-user', 'app:ready-to-quit']);
  });
});
