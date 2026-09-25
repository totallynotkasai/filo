/**
 * `boardCacheStore.syncTile` never silently overwrites an external edit.
 *
 * The manual sync writes the open note's queued body. An external editor
 * that changed the note's body since Filo read it would be silently
 * overwritten — Filo's worst class of data loss because the user never sees
 * a prompt. The note writer compares the body on disk with the one the local
 * body was built on (bytes, not mtime, so a same-size overwrite on a
 * coarse-clock volume is caught too): on a mismatch the write is held, the
 * conflict prompt opens, and the sync reports it skipped. Keep mine writes
 * the local body; Reload keeps theirs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition, KanbanBoard } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

function makeKanbanFixtureWithTextTile(): BoardFileData {
  const def: TileDefinition = {
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
        {
          id: 'c1',
          title: 'To Do',
          position: 0,
          collapsed: false,
          tilePlacements: [{ tileId: 't1' }],
        },
      ],
    } as unknown as KanbanBoard,
    tileDefs: { t1: def },
    connections: {},
    frames: [],
  };
}

const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), writeTargetMissing: vi.fn(), reloadShrank: vi.fn(), dismiss: vi.fn() };

/** Hydrates the board and opens the note with `body` typed but not yet written. */
async function seedBoardAndNote(body: string): Promise<void> {
  boardCacheStore.hydrate(
    { kb: makeKanbanFixtureWithTextTile() },
    { kb: 'tasks.board.json' },
  );
  const m = noteStore.acquire('note.md', 'tile');
  await m.loaded;
  noteStore.setBody('note.md', body, 'tile');
}

describe('boardCacheStore.syncTile — external edit guard', () => {
  let vault: MemoryVault;

  const noteWrites = (): string[] =>
    vault.writes.filter(([, rel]) => rel === 'note.md').map(([, , text]) => text);

  beforeEach(() => {
    restoreFiloDefault();
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    vault = installMemoryVault({ 'note.md': '---\ntitle: Note\n---\nAAAA\n' });
    for (const fn of Object.values(prompts)) fn.mockReset();
    setNotePromptHandlers(prompts);
  });
  afterEach(() => {
    noteStore.__resetForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    restoreFiloDefault();
  });

  it('no external change → write proceeds', async () => {
    await seedBoardAndNote('Local body to write\n');

    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(true);
    expect(result.skippedReason).toBeUndefined();
    expect(noteWrites()).toEqual(['---\ntitle: Note\n---\nLocal body to write\n']);
    expect(prompts.conflict).not.toHaveBeenCalled();
  });

  it('external body edit → prompt fires and nothing is written; Reload keeps theirs', async () => {
    await seedBoardAndNote('Local body to write\n');
    vault.writeExternally('note.md', '---\ntitle: Note\n---\nDisk body from elsewhere\n');

    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(false);
    expect(result.skippedReason).toBeDefined();
    expect(noteWrites()).toEqual([]);
    expect(prompts.conflict).toHaveBeenCalledOnce();

    await noteStore.resolveConflict('note.md', 'reload');
    await noteStore.flushAll();
    expect(vault.read('note.md')).toBe('---\ntitle: Note\n---\nDisk body from elsewhere\n');
    expect(noteStore.get('note.md')?.body).toBe('Disk body from elsewhere\n');
  });

  it('external body edit → Keep mine writes the local body', async () => {
    await seedBoardAndNote('Local body to write\n');
    vault.writeExternally('note.md', '---\ntitle: Note\n---\nDisk body from elsewhere\n');

    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(false);
    expect(prompts.conflict).toHaveBeenCalledOnce();

    await noteStore.resolveConflict('note.md', 'keep-mine');
    expect(vault.read('note.md')).toBe('---\ntitle: Note\n---\nLocal body to write\n');
  });

  it('same-size external overwrite (what an mtime/size check misses) → still held', async () => {
    await seedBoardAndNote('Local body to write\n');
    // Same length as the original `AAAA` body.
    vault.writeExternally('note.md', '---\ntitle: Note\n---\nBBBB\n');

    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(false);
    expect(noteWrites()).toEqual([]);
    expect(vault.read('note.md')).toBe('---\ntitle: Note\n---\nBBBB\n');
    expect(prompts.conflict).toHaveBeenCalledOnce();
  });

  it('an external rewrite with identical bytes → no prompt, write proceeds', async () => {
    await seedBoardAndNote('Local body to write\n');
    vault.writeExternally('note.md', '---\ntitle: Note\n---\nAAAA\n');

    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(true);
    expect(noteWrites()).toHaveLength(1);
    expect(prompts.conflict).not.toHaveBeenCalled();
  });

  it('a tile whose note no view has open writes nothing', async () => {
    boardCacheStore.hydrate(
      { kb: makeKanbanFixtureWithTextTile() },
      { kb: 'tasks.board.json' },
    );
    const result = await boardCacheStore.syncTile('t1');
    expect(result.wrote).toBe(false);
    expect(noteWrites()).toEqual([]);
  });
});
