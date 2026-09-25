/**
 * "Sync this tile" on a text tile whose backing file was deleted from the OS
 * must not recreate the file from memory: it reports the write as not landed
 * instead. When the file is there, the tile's queued body is written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, KanbanBoard } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;

function makeKanbanFixtureWithTextTile(): V7BoardFileData {
  const def = {
    id: 't1',
    type: 'text',
    filePath: 'note.md',
    style: {
      headerColor: '#000',
      bodyColor: '#fff',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    } as never,
    createdAt: 0,
    updatedAt: 0,
  } as TileDefinition;

  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        { id: 'c1', title: 'To Do', position: 0, collapsed: false, tilePlacements: [{ tileId: 't1' }] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { t1: def },
    connections: {},
    frames: [],
  };
}

describe('boardCacheStore.syncTile — deleted backing file', () => {
  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    vault = installMemoryVault({ 'note.md': '# Disk content\n' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    boardCacheStore.hydrate({ kb: makeKanbanFixtureWithTextTile() }, { kb: 'tasks.board.json' });
    const m = noteStore.acquire('note.md', 'tile:t1');
    await m.loaded;
  });
  afterEach(() => {
    noteStore.__resetForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vi.restoreAllMocks();
    restoreFiloDefault();
  });

  it('reports not written, and never recreates the deleted file', async () => {
    noteStore.setBody('note.md', 'Local body that should NOT resurrect the deleted file.', 'tile:t1');
    vault.remove('note.md');

    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(false);
    expect(result.skippedReason).toBeTruthy();
    expect(vault.read('note.md')).toBeUndefined();
    expect(vault.writes.filter(([, rel]) => rel === 'note.md')).toEqual([]);
  });

  it('returns wrote:true when the write succeeds', async () => {
    noteStore.setBody('note.md', 'New body content', 'tile:t1');

    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(true);
    expect(result.skippedReason).toBeUndefined();
    expect(vault.read('note.md')).toBe('New body content\n');
  });
});
