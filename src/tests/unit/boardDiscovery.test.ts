import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { adoptBoardAtRuntime, adoptUntrackedTreeBoards } from '@renderer/stores/boardDiscovery';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { captureVaultIdentity, beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { unloadedBoardPaths } from '@renderer/stores/unloadedBoards';

/**
 * `board:list` ran only at vault open, so a `.board.json`
 * that appeared mid-session (sync, copy) was invisible until the vault was
 * reopened. `adoptBoardAtRuntime` loads it into the running session.
 */

function envelope(id: string, name: string) {
  return {
    version: 8,
    board: {
      id, type: 'mindmap', name, emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      placements: {}, inlineTiles: {}, waypoints: [],
    },
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('runtime board discovery', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
    boardCacheStore.hydrate(
      { b1: envelope('b1', 'Existing') as unknown as BoardFileData },
      { b1: 'Existing.board.json' },
    );
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });
  afterEach(() => {
    boardCacheStore.hydrate({}, {});
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    restoreFiloDefault();
  });

  it('an untracked .board.json is adopted and openable (bite: ignored until reopen)', async () => {
    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      'board:load': () => ({ success: true, data: envelope('b2', 'Synced') }),
    });
    const outcome = await adoptBoardAtRuntime('Synced.board.json', captureVaultIdentity());
    expect(outcome).toBe('adopted');
    expect(boardCacheStore.paths.b2).toBe('Synced.board.json');
    expect(boardCacheStore.cache.b2?.board.name).toBe('Synced');
  });

  it('a duplicate id is NOT adopted; the notice names both files and asks for no deletion', async () => {
    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      'board:load': () => ({ success: true, data: envelope('b1', 'Existing copy') }),
    });
    const outcome = await adoptBoardAtRuntime('Existing - Copy.board.json', captureVaultIdentity());
    expect(outcome).toBe('duplicate');
    expect(boardCacheStore.paths.b1).toBe('Existing.board.json');
    const toast = uiStore.toasts.find((t) => t.dedupeKey === 'dup-board:Existing - Copy.board.json');
    expect(toast?.text).toContain('Existing.board.json');
    expect(toast?.text).toContain('Existing - Copy.board.json');
    expect(toast?.text).not.toMatch(/remove the copy|delete/i);
  });

  it('a vault swap during the load → nothing injected into the new vault', async () => {
    const captured = captureVaultIdentity();
    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      'board:load': () => {
        beginVaultGeneration('/other'); // swap lands mid-load
        return { success: true, data: envelope('b3', 'Outgoing') };
      },
    });
    const outcome = await adoptBoardAtRuntime('Outgoing.board.json', captured);
    expect(outcome).toBe('failed');
    expect(boardCacheStore.paths.b3).toBeUndefined();
  });

  it('the tree scan adopts each untracked board once, quietly', async () => {
    let loads = 0;
    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      'board:load': () => {
        loads++;
        return { success: false, code: 'PARSE', error: 'bad' };
      },
    });
    const tree = ['Existing.board.json', 'Broken.board.json', 'notes.md'];
    await adoptUntrackedTreeBoards(tree, captureVaultIdentity());
    await adoptUntrackedTreeBoards(tree, captureVaultIdentity());
    expect(loads).toBe(1); // tried once, known board skipped
    expect(uiStore.toasts).toHaveLength(0); // quiet: already reported at open
  });

  it('a tree refresh during a board create never marks the new board unloaded', async () => {
    let loads = 0;
    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      // The empty reservation `board:create` makes before it writes the JSON.
      'board:load': () => {
        loads++;
        return { success: false, code: 'PARSE', error: 'Unexpected end of JSON input' };
      },
      'board:create': async () => {
        await adoptUntrackedTreeBoards(['Fresh.board.json'], captureVaultIdentity());
        return { ok: true, path: 'Fresh.board.json', mtimeMs: 2, size: 2 };
      },
      'vault:list-tree': () => ({ success: true, data: [] }),
    });
    const board = await boardCacheStore.createBoard('Fresh', 'kanban');
    expect(board).not.toBeNull();
    expect(loads).toBe(0);
    expect(unloadedBoardPaths()).not.toContain('Fresh.board.json');
  });

  it('loaded board file gone: followed as a rename, with no duplicate-id warning', async () => {
    const renames: Array<[string, string]> = [];
    const spy = vi.spyOn(vaultStore, 'handleExternalRename').mockImplementation(async (from: string, to: string) => {
      renames.push([from, to]);
    });
    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      'vault:file-exists': (_root: unknown, rel: unknown) => rel !== 'Existing.board.json',
      'board:load': () => ({ success: true, data: envelope('b1', 'Existing') }),
    });
    try {
      const outcome = await adoptBoardAtRuntime('Renamed.board.json', captureVaultIdentity());
      expect(outcome).toBe('renamed');
      await vaultStore.enqueueRenameQueueWork(async () => undefined);
      expect(renames).toEqual([['Existing.board.json', 'Renamed.board.json']]);
      expect(uiStore.toasts.some((t) => t.dedupeKey?.startsWith('dup-board:'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('loaded board file still there: a real copy, so no rename', async () => {
    const spy = vi.spyOn(vaultStore, 'handleExternalRename').mockResolvedValue(undefined);
    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      'vault:file-exists': () => true,
      'board:load': () => ({ success: true, data: envelope('b1', 'Existing copy') }),
    });
    try {
      const outcome = await adoptBoardAtRuntime('Existing - Copy.board.json', captureVaultIdentity());
      expect(outcome).toBe('duplicate');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
