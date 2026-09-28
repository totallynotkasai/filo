/**
 * Vault lifecycle and write-queue edges: what happens to work that is still
 * in motion while a vault is let go, and to a write that finishes while a
 * newer one of the same file waits.
 *
 * - The outgoing vault's generation is retired before the swap's resets run,
 *   so suspended work reads as stale and a queued reconcile is skipped.
 * - A tree read that lands after the vault changed is not applied.
 * - A board created while the vault is let go stays with that vault.
 * - A finished write leaves its path pending while a newer write is armed.
 * - Quit makes the same unsaved-work check as close, with the editors frozen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  beginVaultGeneration,
  captureVaultIdentity,
  isStillSameVault,
  isVaultRetired,
  retireVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { enqueueRenameQueueWork, settleRenameQueue } from '@renderer/stores/vaultRenameQueue';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { createScheduler } from '@renderer/lib/boards/writeScheduler';
import { saveBeforeLeaving } from '@renderer/stores/vaultLeaveGuard';
import {
  dropPendingPath,
  noteAdditionalPendingPath,
  isPathPending,
  isUnsavedWorkEmpty,
  trackComponentWrite,
  unsavedWork,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { handleFlushAndQuit, __resetQuitDrainingForTests } from '@renderer/lib/vault/handleFlushAndQuit';
import { uiStore } from '@renderer/stores/ui.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { FileTreeNode } from '../../shared/types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  restoreFiloDefault();
  __resetVaultIdentityForTests();
  __resetDirtyTrackingForTests();
});

describe('letting a vault go retires its generation first', () => {
  beforeEach(() => __resetVaultIdentityForTests());

  it('an identity captured before the retire is stale, and the window lasts until the next vault', () => {
    beginVaultGeneration('/a');
    const before = captureVaultIdentity();
    retireVaultGeneration();
    expect(isStillSameVault(before)).toBe(false);
    expect(isVaultRetired()).toBe(true);
    // Work captured inside the window is consistent with itself (the resets
    // still act on the outgoing vault) ...
    const inside = captureVaultIdentity();
    expect(inside.path).toBe('/a');
    expect(isStillSameVault(inside)).toBe(true);
    // ... and stale once the next vault (or none) is active.
    beginVaultGeneration('/b');
    expect(isVaultRetired()).toBe(false);
    expect(isStillSameVault(inside)).toBe(false);
  });

  it('a reconcile queued before or during the leave does not run', async () => {
    beginVaultGeneration('/a');
    const ran: string[] = [];
    let release!: () => void;
    const busy = new Promise<void>((r) => { release = r; });
    void enqueueRenameQueueWork(async () => { await busy; ran.push('running'); });
    await sleep(0); // the first task is under way
    void enqueueRenameQueueWork(async () => { ran.push('queued before'); });
    retireVaultGeneration();
    void enqueueRenameQueueWork(async () => { ran.push('queued during'); });
    release();
    await settleRenameQueue();
    expect(ran).toEqual(['running']);
  });

  it('settleRenameQueue waits for work a task enqueues itself', async () => {
    beginVaultGeneration('/a');
    const ran: string[] = [];
    void enqueueRenameQueueWork(async () => {
      await sleep(5);
      void enqueueRenameQueueWork(async () => { await sleep(5); ran.push('follow-up'); });
      ran.push('first');
    });
    await settleRenameQueue();
    expect(ran).toEqual(['first', 'follow-up']);
  });
});

describe('a tree read that lands after the vault changed', () => {
  afterEach(() => {
    vaultStore.setTree([]);
    vaultStore.setPath('');
  });

  it('is not applied, and reports the read as not current', async () => {
    const node = (path: string): FileTreeNode => ({ name: path.split('/').pop() ?? path, path, isDirectory: false });
    vaultStore.setPath('/a');
    vaultStore.setTree([node('/a/Old.md')]);
    let answer!: (v: unknown) => void;
    installFiloMock({ 'vault:read-tree': () => new Promise((r) => { answer = r; }) });
    const refreshed = vaultStore.refreshTree();
    await sleep(0);
    vaultStore.setPath('/b');
    answer({ ok: true, tree: [node('/a/From-A.md')] });
    expect(await refreshed).toBe(false);
    expect(vaultStore.tree.map((n) => n.path)).toEqual(['/a/Old.md']);
  });
});

describe('a board created while its vault is let go', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    vaultStore.setPath('/a');
  });
  afterEach(() => {
    boardCacheStore.clear();
    vaultStore.setPath('');
  });

  it('is left on disk for that vault and not registered in the next one', async () => {
    installFiloMock({
      'board:create': () => {
        vaultStore.setPath('/b');
        return { ok: true, path: 'Plan.board.json', mtimeMs: 1, size: 2 };
      },
    });
    const board = await boardCacheStore.createBoard('Plan', 'kanban');
    expect(board).toBeNull();
    expect(Object.values(boardCacheStore.paths)).not.toContain('Plan.board.json');
  });
});

describe('a write that finishes while a newer one of the same file is armed', () => {
  beforeEach(() => __resetDirtyTrackingForTests());

  it('leaves the path pending until the newer write lands', async () => {
    installFiloMock({});
    const gates: Array<() => void> = [];
    const scheduler = createScheduler<{ path: string }>({
      name: 'test',
      debounceMs: 5,
      sentinelMode: 'pending-path',
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
      performWrite: async (a) => {
        await trackComponentWrite('/vault', a.path, () => new Promise<void>((r) => { gates.push(r); }));
      },
    });
    try {
      scheduler.schedule('n', () => ({ path: 'Note.md' }));
      await sleep(20); // the first write is out
      expect(gates).toHaveLength(1);
      scheduler.schedule('n', () => ({ path: 'Note.md' })); // a newer change arms
      gates[0]();
      await sleep(0);
      expect(isPathPending('Note.md')).toBe(true);
      expect(isUnsavedWorkEmpty(unsavedWork())).toBe(false);
      await sleep(20); // the newer write fires (behind the first) and is out
      gates[1]?.();
      await scheduler.flushAll();
      expect(isPathPending('Note.md')).toBe(false);
    } finally {
      scheduler.reset();
    }
  });
});

describe('leaving waits for queued reconciles before its last check', () => {
  it('saves again what a reconcile queued while the first save ran', async () => {
    __resetDirtyTrackingForTests();
    beginVaultGeneration('/vault');
    const dialogs: unknown[] = [];
    installFiloMock({ 'dialog:choice': (...args: unknown[]) => { dialogs.push(args); return 1; } });
    let saves = 0;
    const save = async (): Promise<boolean> => {
      saves++;
      dropPendingPath('/vault', 'Board.board.json');
      return true;
    };
    // A watcher reconcile under way: it rebinds a board and queues its write.
    void enqueueRenameQueueWork(async () => {
      await sleep(20);
      noteAdditionalPendingPath('/vault', 'Board.board.json');
    });
    const outcome = await saveBeforeLeaving(save, 'close');
    expect(outcome).toBe('saved');
    expect(saves).toBe(2);
    expect(isUnsavedWorkEmpty(unsavedWork())).toBe(true);
    expect(dialogs).toEqual([]);
  });
});

describe('quit makes the same check as close', () => {
  beforeEach(() => {
    __resetQuitDrainingForTests();
    uiStore.closeConfirm();
  });
  afterEach(() => {
    __resetQuitDrainingForTests();
    uiStore.closeConfirm();
  });

  it('asks when unsaved work is left even though the save reported success, and thaws on Stay open', async () => {
    const sent: string[] = [];
    let frozen = false;
    const quit = handleFlushAndQuit({
      saveStateState: () => 'saved',
      save: async () => true,
      nothingUnsaved: () => false,
      freeze: () => {
        frozen = true;
        return () => { frozen = false; };
      },
      send: (c) => { sent.push(c); },
      reportError: () => {},
    });
    await sleep(10);
    expect(frozen).toBe(true);
    expect(sent).not.toContain('app:ready-to-quit');
    expect(uiStore.confirmDialog?.title).toBe('Save failed');
    const cfg = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    cfg.onCancel?.();
    await quit;
    expect(sent).toContain('app:cancel-quit');
    expect(frozen).toBe(false);
  });

  it('keeps the editors frozen when the quit goes ahead', async () => {
    let frozen = false;
    const sent: string[] = [];
    await handleFlushAndQuit({
      saveStateState: () => 'saved',
      save: async () => true,
      nothingUnsaved: () => true,
      freeze: () => {
        frozen = true;
        return () => { frozen = false; };
      },
      send: (c) => { sent.push(c); },
      reportError: () => {},
    });
    expect(sent).toContain('app:ready-to-quit');
    expect(frozen).toBe(true);
  });
});
