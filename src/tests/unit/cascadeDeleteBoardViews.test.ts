import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { workspaceStore } from '@renderer/stores/workspace.svelte';
import { CascadeDeleteCommand } from '@renderer/commands/index';
import { cancelAllPendingWrites, resetWriteTracking } from '@renderer/lib/boards/boardSaver';
import { clearViewportsCache, getViewportFromCache, removeViewport, setViewport } from '@renderer/lib/boards/viewportCache';
import { installMemoryVault } from '../helpers/memoryVault';

/**
 * A sidebar delete takes the boards inside the item with it, and with them
 * their camera and side-toolbar place. The cascade step's undo puts both back
 * once the file is back, as the Board Browser's delete does; a redo records
 * them again, so the next undo puts back how the board looked then.
 */

const ROOT = '/v';
const BOARD = 'Plan/Plan.board.json';

function installBoardVault(): void {
  installMemoryVault({ [BOARD]: '{}\n' }, ROOT);
  const base = window.filo.invoke as (channel: string, ...args: unknown[]) => Promise<unknown>;
  window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
    if (channel === 'vault:read-tree') return { ok: true, tree: [] };
    return base(channel, ...args);
  }) as typeof window.filo.invoke;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function camera(boardId: string): { x: number; y: number; scale: number } | null {
  const vp = getViewportFromCache(boardId);
  return vp ? { x: vp.x, y: vp.y, scale: vp.scale } : null;
}

describe('CascadeDeleteCommand and the views of the boards it took', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    historyStore.setActiveBoard('mm');
    cancelAllPendingWrites();
    resetWriteTracking();
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    workspaceStore.removeBoardToolbar('p');
    clearViewportsCache();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    cancelAllPendingWrites();
    resetWriteTracking();
  });

  it('undo puts back the camera and side toolbar; a redo records them again', async () => {
    installBoardVault();
    vaultStore.setPath(ROOT);
    const moved = (await window.filo.invoke('vault:trash-move', ROOT, BOARD)) as { trashId: string };
    const cmd = new CascadeDeleteCommand({}, [], {
      vaultRoot: ROOT,
      trashed: { rel: BOARD, trashId: moved.trashId },
      boardViews: {
        p: { viewport: { x: 10, y: 20, scale: 1.5, updatedAt: 1 }, toolbar: { position: { x: 30, y: 40 }, pinned: true } },
      },
    });
    await historyStore.execute(cmd);
    expect(camera('p')).toBeNull();

    await historyStore.undo();
    await settle();
    expect(camera('p')).toEqual({ x: 10, y: 20, scale: 1.5 });
    expect(workspaceStore.boardToolbar('p')).toEqual({ position: { x: 30, y: 40 }, pinned: true });

    // The board is moved around, then deleted again.
    setViewport('p', { x: 99, y: 98, scale: 0.5, updatedAt: 2 });
    await historyStore.redo();
    await settle();
    // What the delete's cleanup does to a board whose file went with the item.
    removeViewport('p');
    workspaceStore.removeBoardToolbar('p');

    await historyStore.undo();
    await settle();
    expect(camera('p')).toEqual({ x: 99, y: 98, scale: 0.5 });
  });
});
