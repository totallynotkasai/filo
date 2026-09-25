import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import {
  vaultPathForTile,
  makeKanbanFrontmatterWriter,
} from '@renderer/lib/kanban/kanbanFrontmatterWriter';
import {
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import type { KanbanBoard as KanbanBoardType, Tile } from '@renderer/schema/index';
import { restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault } from '../helpers/memoryVault';

/**
 * The Kanban frontmatter writer resolves a card's note from the def's explicit
 * `filePath`. After a restart no note is loaded (boards don't preload notes),
 * so a resolver that guessed `${title}.md` at the vault ROOT would send a
 * subfolder card's edit there: lost on ENOENT, or silently written into an
 * unrelated same-named root note.
 */

describe('vaultPathForTile — honors the def filePath', () => {
  afterEach(() => {
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('returns the subfolder filePath for a card with no note loaded', () => {
    const tile = {
      id: 't1',
      type: 'text',
      title: 'Card',
      filePath: 'Folder/Card.md',
      tags: [],
    } as unknown as Tile;
    expect(vaultPathForTile(tile)).toBe('Folder/Card.md');
  });

  it('returns null for a non-text tile', () => {
    const tile = { id: 't2', type: 'image', title: 'Img', tags: [] } as unknown as Tile;
    expect(vaultPathForTile(tile)).toBeNull();
  });

  it('does not guess a path from an open note when no filePath is set', async () => {
    vaultStore.setPath('/vault');
    installMemoryVault({ 'Notes/Real.md': '---\ntitle: X\n---\n' });
    await noteStore.acquire('Notes/Real.md', 'doc').loaded;
    const tile = {
      id: 't3',
      type: 'text',
      title: 'X',
      tags: [],
    } as unknown as Tile;
    // A card's note is named only by its filePath; without one it has no note.
    expect(vaultPathForTile(tile)).toBeNull();
  });

  it('does not guess ${title}.md at root when neither filePath nor a note exists', () => {
    const tile = { id: 't4', type: 'text', title: 'Loose', tags: [] } as unknown as Tile;
    expect(vaultPathForTile(tile)).toBeNull();
  });
});

describe('updateTileFrontmatter — writes to the subfolder path end-to-end', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    restoreFiloDefault();
    vi.restoreAllMocks();
  });

  it('a subfolder card (no note loaded) writes to Folder/Card.md, NOT Card.md at root', async () => {
    const tile = {
      id: 't1',
      type: 'text',
      title: 'Card',
      filePath: 'Folder/Card.md',
      tags: [],
    } as unknown as Tile;
    const rootNote = '---\ntitle: Unrelated\n---\nroot body\n';
    const vault = installMemoryVault({
      'Folder/Card.md': '---\ncompleted: false\n---\ncard body\n',
      'Card.md': rootNote,
    });

    const writer = makeKanbanFrontmatterWriter({
      getBoard: () => ({ id: 'kb', type: 'kanban', columns: [] }) as unknown as KanbanBoardType,
      getAllTilesById: () => ({ [tile.id]: tile }),
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
    });
    await writer.updateTileFrontmatter(tile.id, { priority: 'high' });
    expect((await noteStore.flushAll()).failed).toEqual([]);

    // The edit landed at the subfolder path and NEVER at the wrong root path.
    const paths = vault.writes.map(([, rel]) => rel);
    expect(paths).toContain('Folder/Card.md');
    expect(paths).not.toContain('Card.md');
    expect(vault.read('Folder/Card.md')).toBe('---\ncompleted: false\npriority: high\n---\ncard body\n');
    expect(vault.read('Card.md')).toBe(rootNote);
  });
});
