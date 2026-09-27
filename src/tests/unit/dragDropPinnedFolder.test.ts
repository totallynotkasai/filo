import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Only the copy's arguments matter here; the tile factory is stubbed so the
// test doesn't pull in createTile's font / name defaults.
vi.mock('@renderer/stores/tiles.svelte', () => ({
  createTile: (type: string, position: { x: number; y: number }, boardId: string, overrides?: Record<string, unknown>) =>
    ({ id: 'tile-1', type, position, boardId, size: { width: 10, height: 10 }, ...overrides }),
  getTileTypeFromExtension: () => 'image',
  getTileTypeFromMime: () => 'image',
}));

const copyCalls: unknown[][] = [];
vi.mock('@renderer/lib/vault/vaultOperations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/vault/vaultOperations')>();
  return {
    ...actual,
    copyFileIntoVault: async (...args: unknown[]) => {
      copyCalls.push(args);
      return { success: true, path: 'C:/vault/Pinned/pic.png', relativePath: 'Pinned/pic.png' };
    },
  };
});

import { dragDropAction } from '@renderer/lib/canvas/dragDrop';
import { resetActiveScope, type BoardScope } from '@renderer/lib/boards/boardScope.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A file dropped from the OS onto a mind map while the board has a folder
 * pin: the copy names the vault itself as its root (main refuses any other
 * path there, `assertActiveVault`) and the pinned folder as its destination.
 */
function osFileDrop(file: File): Event {
  const e = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files: [file], getData: () => '' } });
  Object.defineProperty(e, 'clientX', { value: 10 });
  Object.defineProperty(e, 'clientY', { value: 10 });
  return e;
}

describe('mind-map OS drop with a folder pin', () => {
  beforeEach(() => {
    copyCalls.length = 0;
    installFiloMock(() => ({ ok: true, success: true }));
    vaultStore.setPath('C:/vault');
    vi.spyOn(vaultStore, 'refreshTree').mockResolvedValue(true);
    historyStore.clear();
  });
  afterEach(() => {
    resetActiveScope();
    historyStore.clear();
    vaultStore.setPath('');
    restoreFiloDefault();
    vi.restoreAllMocks();
  });

  it('copies into the pinned folder of the vault, and the tile names the copy', async () => {
    const addTile = vi.fn();
    const scope = {
      board: {
        current: { id: 'b1', settings: { defaultFolder: 'Pinned' } },
        addTile,
        getTile: () => undefined,
        markDirty: vi.fn(),
        tiles: {},
      },
      canvas: { transform: { x: 0, y: 0, scale: 1 } },
    } as unknown as BoardScope;
    const node = document.createElement('div');
    const action = dragDropAction(node, scope);
    const file = new File(['x'], 'pic.png', { type: 'image/png' });
    Object.defineProperty(file, 'path', { value: 'D:/outside/pic.png' });

    node.dispatchEvent(osFileDrop(file));
    await vi.waitFor(() => expect(addTile).toHaveBeenCalledTimes(1));

    expect(copyCalls).toEqual([['D:/outside/pic.png', 'C:/vault', 'Pinned']]);
    expect((addTile.mock.calls[0][0] as { src: string }).src).toBe('Pinned/pic.png');
    (action as { destroy?: () => void }).destroy?.();
  });
});
