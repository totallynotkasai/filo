import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { makeKanbanFrontmatterWriter } from '@renderer/lib/kanban/kanbanFrontmatterWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard as KanbanBoardType, Tile } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * An external edit to a card no view has open must survive the card's next
 * field edit. The card's frontmatter was read once (when the card was
 * edited earlier); another program then adds a key and the watcher reports
 * it. The next field edit must land on the file as it is now, keeping that
 * key, not on an earlier copy.
 */

/**
 * Hydrates the board cache with one Kanban board carrying a single card backed
 * by `Card.md`, and returns the card's runtime tile.
 */
function hydrateBoardWithCard(boardId: string): Tile {
  const data: V7BoardFileData = {
    version: 8,
    board: {
      id: boardId,
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
    } as unknown as KanbanBoardType,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        filePath: 'Card.md',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        createdAt: 0,
        updatedAt: 0,
      },
    },
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ [boardId]: data }, { [boardId]: `${boardId}.board.json` });
  return { id: 't1', type: 'text', filePath: 'Card.md', title: 'Card', tags: [] } as unknown as Tile;
}

function makeCtx(): VaultContext {
  return {
    getVaultPath: () => '/vault',
    setVaultPath: () => {},
    getFileTree: () => [],
    setFileTree: () => {},
    getSearchQuery: () => '',
    setSearchQuery: () => {},
    getIsLoading: () => false,
    setIsLoading: () => {},
    getExpandedFolders: () => new Set(),
    setExpandedFolders: () => {},
    getSelectedPaths: () => new Set(),
    setSelectedPaths: () => {},
    getProject: () => null,
    setProject: () => {},
    getRecoveryPendingPaths: () => [],
    setRecoveryPendingPaths: () => {},
    markMetaDirty: () => {},
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
    resolveRecoveryDismissed: () => {},
  };
}

describe('external edit to a not-open card is not reverted by its next field edit', () => {
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let vault: MemoryVault;

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vault = installMemoryVault({ 'Card.md': '---\ncompleted: false\n---\ncard body\n' });
    slice = makeExternalChangesSlice(makeCtx());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  it('the next field edit preserves the externally-added key on disk', async () => {
    const tile = hydrateBoardWithCard('kb');
    const writer = makeKanbanFrontmatterWriter({
      getBoard: () => ({ id: 'kb', type: 'kanban', columns: [] }) as unknown as KanbanBoardType,
      getAllTilesById: () => ({ t1: tile }),
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
    });

    // The card was field-edited once before (its frontmatter was read then).
    await vaultIndexStore.applyChanges(['Card.md']);
    await writer.updateTileFrontmatter('t1', { priority: 'low' });
    await noteStore.flushAll();

    // An external editor adds `status: blocked`; the watcher reports it.
    vault.writeExternally('Card.md', '---\ncompleted: false\npriority: low\nstatus: blocked\n---\ncard body\n');
    await slice.handleExternalMarkdownChanges(['Card.md']);

    // Now the user toggles `completed` on the (still not-open) card.
    await writer.updateTileFrontmatter('t1', { completed: true });
    await noteStore.flushAll();

    expect(vault.read('Card.md')).toBe('---\ncompleted: true\npriority: low\nstatus: blocked\n---\ncard body\n');
  });
});
