/**
 * A note may write its tags as text (`tags: project`, `tags: a, b`) rather
 * than a list. Kanban reads them through the one tags normaliser: the bulk
 * "Add tag" adds to them in the note's own form (never replaces them), and
 * the tag filter matches them instead of throwing on a string.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KanbanMultiSelect } from '@renderer/lib/kanban/kanbanMultiSelect.svelte';
import { KanbanFiltersAndSort } from '@renderer/lib/kanban/kanbanFiltersAndSort.svelte';
import { createSelectionScope } from '@renderer/stores/selection.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import type { KanbanBoard as KanbanBoardType, Tile } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const A = '---\ntitle: A\ntags: project\n---\nBody A\n';
const B = '---\ntitle: B\ntags: [urgent]\n---\nBody B\n';

function card(id: string): Tile {
  return { id, type: 'text', filePath: `${id}.md`, title: id, tags: [] } as unknown as Tile;
}

let vault: MemoryVault;

beforeEach(() => {
  __resetVaultIdentityForTests();
  vault = installMemoryVault({ 'a.md': A, 'b.md': B });
  vaultStore.setPath('/vault');
  beginVaultGeneration('/vault');
  vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', A));
  vaultIndexStore.restoreMetadata('b.md', parseMarkdown('b.md', B));
  vi.spyOn(fileTagsStore, 'ensureTag').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await historyStore.whenChainSettled?.();
  noteStore.__resetForTests();
  vaultStore.setPath('');
  restoreFiloDefault();
});

describe('Kanban bulk "Add tag" on a note whose tags are text', () => {
  it('adds the tag and keeps the one the note had', async () => {
    const selection = createSelectionScope();
    selection.addMultiple(['a', 'b']);
    const tiles = { a: card('a'), b: card('b') };
    const ms = new KanbanMultiSelect({
      selection,
      getBoardId: () => 'kb',
      getColumns: () => [] as unknown as KanbanBoardType['columns'],
      getAllTilesById: () => tiles,
      getFlatVisibleTileIds: () => ['a', 'b'],
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
      ensureSeededFm: () => null,
      vaultPathForTile: (t: Tile) => `${t.id}.md`,
      promptForTag: () => Promise.resolve('urgent'),
    });

    await ms.tagSelectedTiles();
    await noteStore.flushAll();

    // The rewriter's rule for a text-form field: a list of what it said, plus the new tag.
    expect(vault.read('a.md')).toBe('---\ntitle: A\ntags:\n  - project\n  - urgent\n---\nBody A\n');
    // B already had the tag: untouched.
    expect(vault.read('b.md')).toBe(B);
  });
});

describe('Kanban tag filter on a note whose tags are text', () => {
  it('matches the text-form tag and does not throw', () => {
    const ctl = new KanbanFiltersAndSort({
      getBoardColumns: () => [],
      getAllTilesById: () => ({}),
      getFindQuery: () => '',
      getCacheVersion: () => 0,
    });
    ctl.activeFilterTags = ['project'];
    expect(ctl.tileMatchesFilters(card('a'))).toBe(true);
    ctl.activeFilterTags = ['other'];
    expect(ctl.tileMatchesFilters(card('a'))).toBe(false);
  });
});
