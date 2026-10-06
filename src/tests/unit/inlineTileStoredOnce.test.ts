/**
 * A Mind Map link, embed or timer tile lives once, in `board.inlineTiles`.
 * A second copy in `tileDefs` would never be updated again, and everything
 * that walks the defs would act on its stale title and tags:
 * - adding (or re-adding, as the undo of a delete does) writes no def copy;
 * - a board read with such a copy drops it, and readers skip one left in a
 *   cache, so a tag delete or rename never writes old tags back, its Undo puts
 *   back what it changed, no open warns about tags nothing shows, and search
 *   lists the tile once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { commitTagRemovalInMemory, commitTagRenameInMemory, iterateBoardOnlyTiles } from '@renderer/stores/fileTagsCascade.svelte';
import { undoRemoval } from '@renderer/stores/tagUndo.svelte';
import { runVaultSearch } from '@renderer/lib/search/runSearch';
import { parseQuery } from '@renderer/lib/search/queryParser';
import { loadBoard } from '@renderer/lib/boards/boardLoader';
import { beginVaultGeneration, captureVaultIdentity, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { CURRENT_BOARD_FILE_VERSION } from '@renderer/schema/boardFile';
import { installMemoryVault } from '../helpers/memoryVault';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Tile, MindMapBoard } from '@renderer/schema/index';

function linkTile(tags: string[], title = 'Site'): Tile {
  return {
    id: 'lnk1',
    boardId: 'mm',
    type: 'link',
    title,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: {} as never,
    tags,
    locked: false,
    faded: false,
    url: 'https://example.com',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Tile;
}

function inlineLink(tags: string[], title = 'Site'): Record<string, unknown> {
  return {
    id: 'lnk1', type: 'link', title, url: 'https://example.com', style: { headerColor: '', bodyColor: '' }, tags,
    x: 0, y: 0, width: 200, height: 100, locked: false, faded: false, createdAt: 0, updatedAt: 0,
  };
}

function mindMap(inline: Record<string, unknown> = {}, defs: Record<string, unknown> = {}): BoardFileData {
  return {
    board: {
      id: 'mm', type: 'mindmap', name: 'Map', emoji: '', createdAt: 0, updatedAt: 0,
      settings: {}, placements: {}, inlineTiles: inline, waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: defs as BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  };
}

const board = (): MindMapBoard & { inlineTiles: Record<string, { tags?: string[] }> } =>
  boardCacheStore.cache.mm.board as MindMapBoard & { inlineTiles: Record<string, { tags?: string[] }> };

beforeEach(() => {
  __resetVaultIdentityForTests();
  installMemoryVault({});
  vaultStore.setPath('/vault');
  beginVaultGeneration('/vault');
  boardCacheStore.clear();
  boardCacheStore.hydrate({ mm: mindMap() }, { mm: 'Map.board.json' });
  vi.spyOn(fileTagsStore, 'flushPendingSave').mockResolvedValue({ ok: true });
  vi.spyOn(boardCacheStore, 'flushAllDirty').mockResolvedValue({ failed: [] } as unknown as Awaited<ReturnType<typeof boardCacheStore.flushAllDirty>>);
});

afterEach(() => {
  vi.restoreAllMocks();
  boardCacheStore.clear();
  fileTagsStore.reset();
  vaultStore.setPath('');
  restoreFiloDefault();
});

describe('a Mind Map link, embed or timer tile is stored once', () => {
  it('adding it writes the inline tile and no def beside it', async () => {
    await boardCacheStore.persistAddTile(linkTile(['draft']), { skipEmptySeed: true }, 'mm');
    expect(board().inlineTiles.lnk1?.tags).toEqual(['draft']);
    expect(boardCacheStore.cache.mm.tileDefs.lnk1).toBeUndefined();
  });

  it('a tag removed from the tile no longer counts as carried', async () => {
    await boardCacheStore.persistAddTile(linkTile(['draft']), { skipEmptySeed: true }, 'mm');
    boardCacheStore.persistUpdateTile('lnk1', { tags: [] }, 'mm');
    expect(fileTagsStore.tagInUse('draft')).toBe(false);
  });

  it("a vault-wide tag delete keeps the tile's other tags", async () => {
    // Re-added with its tags (an undo of a delete), then retagged by the user.
    await boardCacheStore.persistAddTile(linkTile(['draft', 'lore']), { skipEmptySeed: true }, 'mm');
    boardCacheStore.persistUpdateTile('lnk1', { tags: ['lore', 'canon'] }, 'mm');
    commitTagRemovalInMemory(fileTagsStore, 'draft');
    expect(boardCacheStore.getFullTilesForBoard('mm').lnk1?.tags).toEqual(['lore', 'canon']);
  });

  it('a vault-wide tag rename does not bring back a tag the user removed', async () => {
    await boardCacheStore.persistAddTile(linkTile(['draft']), { skipEmptySeed: true }, 'mm');
    boardCacheStore.persistUpdateTile('lnk1', { tags: [] }, 'mm');
    commitTagRenameInMemory(fileTagsStore, 'draft', 'wip');
    expect(boardCacheStore.getFullTilesForBoard('mm').lnk1?.tags).toEqual([]);
  });

  it('after a rename, the old name no longer exists (so its Undo is not refused)', async () => {
    await boardCacheStore.persistAddTile(linkTile(['draft']), { skipEmptySeed: true }, 'mm');
    commitTagRenameInMemory(fileTagsStore, 'draft', 'wip');
    expect(boardCacheStore.getFullTilesForBoard('mm').lnk1?.tags).toEqual(['wip']);
    expect(fileTagsStore.tagExists('draft')).toBe(false);
  });

  it('after a vault-wide delete of a tag, no tile still counts as carrying it', async () => {
    await boardCacheStore.persistAddTile(linkTile(['draft']), { skipEmptySeed: true }, 'mm');
    commitTagRemovalInMemory(fileTagsStore, 'draft');
    expect(boardCacheStore.getFullTilesForBoard('mm').lnk1?.tags).toEqual([]);
    // openTagHousekeeping toasts "Found N undefined tag reference(s)" when this is > 0.
    expect(fileTagsStore.detectOrphans().tile).toBe(0);
  });

  it('search lists the tile once, and by its current title only', async () => {
    await boardCacheStore.persistAddTile(linkTile([]), { skipEmptySeed: true }, 'mm');
    expect(runVaultSearch(parseQuery('type:link')).matches.filter((m) => m.tileId === 'lnk1')).toHaveLength(1);
    boardCacheStore.persistUpdateTile('lnk1', { title: 'Renamed' }, 'mm');
    expect(runVaultSearch(parseQuery('Site')).matches.filter((m) => m.tileId === 'lnk1')).toHaveLength(0);
  });
});

describe('a stale second copy already in a board', () => {
  it('readers skip it: a tag delete, its Undo, the orphan count and search see the inline tile only', async () => {
    // The def holds the tags the tile had once; the inline tile holds today's.
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { mm: mindMap({ lnk1: inlineLink(['lore', 'canon', 'draft']) }, { lnk1: { ...inlineLink(['draft', 'old']), filePath: undefined } }) },
      { mm: 'Map.board.json' },
    );
    for (const tag of ['lore', 'canon', 'draft', 'old']) fileTagsStore.ensureTag(tag);
    expect([...iterateBoardOnlyTiles()].map((t) => t.tags)).toEqual([['lore', 'canon', 'draft']]);
    expect(runVaultSearch(parseQuery('type:link')).matches.filter((m) => m.tileId === 'lnk1')).toHaveLength(1);

    // What the delete's snapshot records (removeTagWithUndo), then the delete itself.
    const snapshot = {
      identity: captureVaultIdentity(),
      tagName: 'draft',
      color: undefined,
      writtenPaths: [],
      mediaPaths: [],
      tiles: [...iterateBoardOnlyTiles()]
        .filter((t) => t.tags.includes('draft'))
        .map((t) => ({ boardId: t.boardId, id: t.id, index: t.tags.indexOf('draft') })),
      chips: [],
    };
    commitTagRemovalInMemory(fileTagsStore, 'draft');
    expect(board().inlineTiles.lnk1?.tags).toEqual(['lore', 'canon']);
    expect(fileTagsStore.detectOrphans().tile).toBe(0);

    await undoRemoval(snapshot);
    expect(board().inlineTiles.lnk1?.tags).toEqual(['lore', 'canon', 'draft']);
  });

  it('loading a board drops the copy (in memory: nothing is written for it)', async () => {
    const file = {
      version: CURRENT_BOARD_FILE_VERSION,
      ...mindMap({ lnk1: inlineLink(['lore']) }, { lnk1: { id: 'lnk1', type: 'link', title: 'Old', url: 'https://example.com', style: { headerColor: '', bodyColor: '' }, tags: ['old'], createdAt: 0, updatedAt: 0 } }),
    };
    const calls: string[] = [];
    installFiloMock((channel: string) => {
      calls.push(channel);
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 1 };
      if (channel === 'board:load') return { success: true, data: JSON.parse(JSON.stringify(file)) };
      return { success: true };
    });
    const result = await loadBoard('/vault', 'Map.board.json');
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.data.tileDefs.lnk1).toBeUndefined();
    expect((result.data.board as unknown as { inlineTiles: Record<string, { tags: string[] }> }).inlineTiles.lnk1?.tags).toEqual(['lore']);
    expect(calls).not.toContain('board:save');
    expect(calls).not.toContain('recovery:snapshot');
  });
});
