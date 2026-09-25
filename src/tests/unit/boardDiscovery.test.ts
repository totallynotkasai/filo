import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { adoptBoardAtRuntime, adoptUntrackedTreeBoards } from '@renderer/stores/boardDiscovery';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { captureVaultIdentity, beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-19 EXT-1 — `board:list` ran only at vault open, so a `.board.json`
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

describe('runtime board discovery (Audit-19 EXT-1)', () => {
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
});
