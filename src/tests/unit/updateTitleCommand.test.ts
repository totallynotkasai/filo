/**
 * UpdateTitleCommand — execute → undo round trip.
 *
 * A text tile's title is its note's frontmatter `title:`: the edit rewrites
 * only that key on a fresh disk read, never renames the file, and undo puts
 * the prior title back (or removes the key when the note had none). The
 * formatted `titleHtml` stays on the board and moves with the title. A tile
 * that owns its title (media / board-only) edits its board def.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { UpdateTitleCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';

/** Mutable-disk mock: reads return the current file; writes mutate it; renames are recorded. */
function installDisk(initial: string): { get: () => string; renames: unknown[][] } {
  let disk = initial;
  const renames: unknown[][] = [];
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    if (channel === 'vault:read-file-text') return { success: true, content: disk, mtimeMs: 1, size: disk.length };
    if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: disk.length };
    if (channel === 'vault:write-existing-file-text') {
      disk = args[2] as string;
      return { success: true };
    }
    if (channel === 'vault:rename') {
      renames.push(args);
      return { success: true };
    }
    return undefined;
  });
  return { get: () => disk, renames };
}

const STYLE = { headerColor: '', bodyColor: '', borderColor: '' };

function kanbanFixture(): V7BoardFileData {
  return {
    version: 8,
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Board',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [{ id: 'c1', title: 'Todo', position: 0, tilePlacements: [{ tileId: 't1', position: 0 }, { tileId: 't2', position: 1 }] }],
    } as unknown as KanbanBoard,
    tileDefs: {
      t1: { id: 't1', type: 'text', filePath: 'Errand.md', style: STYLE, createdAt: 0, updatedAt: 0 },
      t2: { id: 't2', type: 'image', title: 'Photo', src: 'pic.png', style: STYLE, createdAt: 0, updatedAt: 0 },
    },
    connections: {},
    frames: [],
  };
}

describe('UpdateTitleCommand', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    noteStore.__resetForTests();
    boardCacheStore.hydrate({ kb: kanbanFixture() }, { kb: 'Board.board.json' });
  });
  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    noteStore.__resetForTests();
  });

  it("a note's title edit rewrites only title:, never renames the file, and undo restores it", async () => {
    const original = '---\ntitle: Errand\n# keep me\npriority: low\n---\nPost office\n';
    const disk = installDisk(original);
    const cmd = new UpdateTitleCommand({
      tileId: 't1',
      boardId: 'kb',
      notePath: 'Errand.md',
      oldTitle: 'Errand',
      newTitle: 'Weekly errand',
      oldTitleHtml: undefined,
      newTitleHtml: '<p><strong>Weekly errand</strong></p>',
    });

    await cmd.execute();
    await noteStore.flushAll();
    expect(disk.get()).toBe(original.replace('title: Errand', 'title: Weekly errand'));
    expect(disk.renames).toEqual([]);
    const def = boardCacheStore.cache.kb.tileDefs.t1 as Record<string, unknown>;
    expect(def.titleHtml).toBe('<p><strong>Weekly errand</strong></p>');
    expect(def.title).toBeUndefined();

    await cmd.undo();
    await noteStore.flushAll();
    expect(disk.get()).toBe(original);
    expect((boardCacheStore.cache.kb.tileDefs.t1 as Record<string, unknown>).titleHtml).toBeUndefined();
  });

  it('a note with no title: gets the key on edit and loses it again on undo', async () => {
    const original = '---\npriority: low\n---\nBody\n';
    const disk = installDisk(original);
    const cmd = new UpdateTitleCommand({
      tileId: 't1',
      boardId: 'kb',
      notePath: 'Errand.md',
      oldTitle: 'Errand',
      newTitle: 'Named',
      oldTitleHtml: undefined,
      newTitleHtml: undefined,
    });

    await cmd.execute();
    await noteStore.flushAll();
    expect(disk.get()).toContain('title: Named');
    expect(disk.get()).toContain('priority: low');

    await cmd.undo();
    await noteStore.flushAll();
    expect(disk.get()).toBe(original);
  });

  it('a tile that owns its title edits its board def, and undo restores it', async () => {
    const disk = installDisk('');
    const cmd = new UpdateTitleCommand({
      tileId: 't2',
      boardId: 'kb',
      notePath: null,
      oldTitle: 'Photo',
      newTitle: 'Holiday',
      oldTitleHtml: undefined,
      newTitleHtml: undefined,
    });

    await cmd.execute();
    expect((boardCacheStore.cache.kb.tileDefs.t2 as Record<string, unknown>).title).toBe('Holiday');
    await cmd.undo();
    expect((boardCacheStore.cache.kb.tileDefs.t2 as Record<string, unknown>).title).toBe('Photo');
    expect(disk.get()).toBe('');
  });
});
