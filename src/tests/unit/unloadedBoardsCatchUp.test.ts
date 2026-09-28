import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { adoptBoardAtRuntime } from '@renderer/stores/boardDiscovery';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { markBoardUnloaded, noticeUnloadedBoards, unloadedBoardPaths } from '@renderer/stores/unloadedBoards';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { captureVaultIdentity, beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import { boardHasUnsavedWrite, cancelAllPendingBoardWrites } from '@renderer/lib/boards/boardWriteScheduler';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A board that failed to load isn't in the cache, so a rename or move made
 * meanwhile can't rewrite its links. The renames are journalled; when the
 * board loads later this session, those made since it failed are applied
 * before it joins the cache, and it is saved. The user is told once which
 * boards weren't reached.
 */

const STYLE = { headerColor: '', bodyColor: '', borderColor: '' };

function planFile(): Record<string, unknown> {
  return {
    version: 8,
    board: {
      id: 'plan', type: 'mindmap', name: 'Plan', emoji: '', createdAt: 1, updatedAt: 1,
      settings: {},
      placements: {
        t1: { x: 0, y: 0, width: 240, height: 160, locked: false, faded: false, frameless: false },
        t2: { x: 300, y: 0, width: 240, height: 160, locked: false, faded: false, frameless: false },
      },
      inlineTiles: {},
      groups: [],
      waypoints: [],
    },
    tileDefs: {
      t1: { id: 't1', style: STYLE, createdAt: 1, updatedAt: 1, type: 'text', filePath: 'Notes/Ideas.md' },
      t2: { id: 't2', style: STYLE, createdAt: 1, updatedAt: 1, type: 'image', title: 'Photo', src: 'Other/pic.png' },
    },
    connections: {},
    frames: [],
  };
}

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

describe('a board that failed to load catches up on the renames it missed', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
    boardCacheStore.hydrate({}, {});
    clearToasts();
  });
  afterEach(() => {
    cancelAllPendingBoardWrites();
    boardCacheStore.hydrate({}, {});
    clearToasts();
    restoreFiloDefault();
  });

  it('a folder rename while it was unloaded is applied when it loads, and the board is saved', async () => {
    markBoardUnloaded('Boards/Plan.board.json');
    renameAllPathKeys('Notes', 'Archive/Notes');

    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      'board:load': () => ({ success: true, data: planFile() }),
    });
    expect(await adoptBoardAtRuntime('Boards/Plan.board.json', captureVaultIdentity())).toBe('adopted');

    const defs = boardCacheStore.cache.plan!.tileDefs as Record<string, { filePath?: string; src?: string }>;
    expect(defs.t1!.filePath).toBe('Archive/Notes/Ideas.md');
    expect(defs.t2!.src).toBe('Other/pic.png');
    expect(boardHasUnsavedWrite('plan')).toBe(true);
    expect(unloadedBoardPaths()).toEqual([]);
  });

  it('only renames made after it failed are applied, and it follows its own folder\'s rename', async () => {
    renameAllPathKeys('Notes', 'Drafts'); // before the failure: not replayed
    markBoardUnloaded('Boards/Plan.board.json');
    renameAllPathKeys('Boards', 'Maps');
    expect(unloadedBoardPaths()).toEqual(['Maps/Plan.board.json']);

    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      'board:load': () => ({ success: true, data: planFile() }),
    });
    await adoptBoardAtRuntime('Maps/Plan.board.json', captureVaultIdentity());
    const defs = boardCacheStore.cache.plan!.tileDefs as Record<string, { filePath?: string }>;
    expect(defs.t1!.filePath).toBe('Notes/Ideas.md');
  });

  it('a load that fails again keeps it on the list, and a move names it once', async () => {
    installFiloMock({
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 1 }),
      'board:load': () => ({ success: false, code: 'PARSE', error: 'bad' }),
    });
    await adoptBoardAtRuntime('Plan.board.json', captureVaultIdentity(), { quiet: true });
    expect(unloadedBoardPaths()).toEqual(['Plan.board.json']);

    noticeUnloadedBoards('moved');
    noticeUnloadedBoards('moved');
    const notices = uiStore.toasts.filter((t) => t.text.includes('Plan.board.json'));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toMatch(/isn't loaded/);
  });
});
