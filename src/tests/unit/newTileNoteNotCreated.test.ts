/**
 * A new Mind Map text tile is put on the board at once and its note is
 * created after. When that create fails (a name the disk refuses, a full
 * disk, a folder that went away), the tile used to stay, pointing at a note
 * that didn't exist, with an undo step for it. It now comes off again, the
 * step goes with it, and the message says the tile wasn't added.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { AddTileCommand } from '@renderer/commands/index';
import { boardDefaults } from '@renderer/core/boardDefaults';
import { TileSchema, type MindMapBoard, type Tile } from '@renderer/schema/index';
import { onError, type ReportedError } from '@renderer/lib/utils/errorBus';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const reported: ReportedError[] = [];
let stopListening: () => void = () => undefined;

function newTextTile(id: string, title: string): Tile {
  return TileSchema.parse({
    id,
    type: 'text',
    boardId: 'mm',
    title,
    content: '',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: { headerColor: '', bodyColor: '' },
    createdAt: 0,
    updatedAt: 0,
  });
}

const placements = (): Record<string, unknown> => (boardCacheStore.cache.mm?.board as MindMapBoard).placements ?? {};

beforeEach(() => {
  installFiloMock(() => null);
  reported.length = 0;
  stopListening = onError((e) => { reported.push(e); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(vaultStore, 'refreshTree').mockResolvedValue(true);
  vaultStore.setPath('/vault');
  boardCacheStore.clear();
  const board = boardDefaults.mindmap('mm', 'Map');
  boardCacheStore.hydrate({ mm: { board, tileDefs: {}, connections: {}, frames: [] } }, { mm: 'Map.board.json' });
  boardStore.setBoard(board);
  historyStore.clear();
  historyStore.setActiveBoard('mm');
});

afterEach(() => {
  stopListening();
  vi.restoreAllMocks();
  historyStore.clear();
  boardCacheStore.clear();
  vaultStore.setPath('');
  restoreFiloDefault();
});

describe('a new tile whose note cannot be created', () => {
  it('comes off the board again, leaves no undo step, and says the tile was not added', async () => {
    vi.spyOn(noteStore, 'createUnique').mockRejectedValue(new Error('ENAMETOOLONG: name too long'));

    void historyStore.execute(new AddTileCommand(newTextTile('t1', 'Idea'), 'mm'));
    // Shown at once, before its note exists.
    expect(boardStore.tiles.t1).toBeDefined();

    await vi.waitFor(() => expect(boardStore.tiles.t1).toBeUndefined());
    expect(placements().t1).toBeUndefined();
    expect(boardCacheStore.cache.mm?.tileDefs.t1).toBeUndefined();
    expect(historyStore.canUndo).toBe(false);
    expect(reported.map((r) => r.message)).toEqual([`Couldn't create the note "Idea.md" for the new tile, so the tile wasn't added`]);
  });

  it('keeps the tile and its step when the note is created', async () => {
    const created = vi.spyOn(noteStore, 'createUnique').mockImplementation(async (first, build) => ({
      relPath: first,
      stem: first.replace(/\.md$/, ''),
      text: build(first.replace(/\.md$/, '')),
    }));

    void historyStore.execute(new AddTileCommand(newTextTile('t2', 'Plot'), 'mm'));

    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(boardStore.tiles.t2).toBeDefined();
    expect(placements().t2).toBeDefined();
    expect(historyStore.canUndo).toBe(true);
    expect(reported).toEqual([]);
  });
});
