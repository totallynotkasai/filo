/**
 * Phase 5 / 5.3 — broken-ref removal goes through history.
 *
 * Before this phase, the broken-ref "Remove from board" quick-action called
 * `boardStore.removeTile` directly with no undo. The fix routes through
 * `boardStore.removeTilesWithHistory([tileId])` (no fileSnapshots — the
 * backing file is already missing, that's why we're removing it). Ctrl+Z
 * restores the placement; the no-snapshots path's "restored tiles reference
 * missing files" toast is exactly the right user signal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { DeleteTilesCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TextTile, Tile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { seedBoard } from '../helpers/seedBoard';

function installSilentBridge(): void {
  installFiloMock(() => null);
}

function makeTile(id: string): TextTile {
  return {
    id,
    boardId: 'mm',
    type: 'text',
    title: `Tile ${id}`,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    tags: [],
    locked: false,
    faded: false,
    filePath: `Notes/Tile ${id}.md`,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TextTile;
}

function activate(tiles: TextTile[]): void {
  const placements: Record<string, unknown> = {};
  const tileDefs: Record<string, unknown> = {};
  for (const t of tiles) {
    placements[t.id] = { id: t.id, tileId: t.id, position: t.position, size: t.size };
    tileDefs[t.id] = {
      id: t.id,
      type: t.type,
      filePath: t.filePath,
      style: t.style,
      createdAt: 0,
      updatedAt: 0,
    };
  }
  const fixture: BoardFileData = {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements,
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: tileDefs as BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  const tilesById: Record<string, Tile> = {};
  for (const t of tiles) tilesById[t.id] = t as unknown as Tile;
  seedBoard(boardStore, fixture.board, tilesById, {}, []);
}

describe('broken-ref Remove from board — Phase 5 / 5.3', () => {
  beforeEach(() => {
    installSilentBridge();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    historyStore.setActiveBoard('mm');
  });
  afterEach(() => {
    restoreFiloDefault();
    historyStore.clear();
    historyStore.setActiveBoard(null);
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('Delete via no-snapshot DeleteTilesCommand removes placement', () => {
    const tile = makeTile('t1');
    activate([tile]);
    expect(boardStore.getTile('t1')).toBeDefined();

    const cmd = new DeleteTilesCommand(['t1']);
    void cmd.execute();
    expect(boardStore.getTile('t1')).toBeUndefined();
  });

  it('undo restores the placement (no file restoration needed for broken refs)', async () => {
    const tile = makeTile('t1');
    activate([tile]);

    const cmd = new DeleteTilesCommand(['t1']);
    await cmd.execute();
    expect(boardStore.getTile('t1')).toBeUndefined();

    cmd.undo();
    expect(boardStore.getTile('t1')).toBeDefined();
    expect(boardStore.getTile('t1')?.title).toBe('Tile t1');
  });

  it('removeTilesWithHistory pushes a command onto the active board stack', async () => {
    const tile = makeTile('t1');
    activate([tile]);

    expect(historyStore.canUndo).toBe(false);
    boardStore.removeTilesWithHistory(['t1']);
    expect(boardStore.getTile('t1')).toBeUndefined();
    expect(historyStore.canUndo).toBe(true);

    await historyStore.undo();
    expect(boardStore.getTile('t1')).toBeDefined();
  });
});
