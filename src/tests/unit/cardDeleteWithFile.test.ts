/**
 * DeleteCardCommand's opt-in note delete, behind a Kanban card's "Delete from
 * vault…", as the Task List's "Delete task and file" has it: the note goes to
 * Filo's trash with the card, and one undo brings the note back before the
 * card. Removing a card from the board alone leaves the note where it is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { DeleteCardCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests, type BoardFileData } from '@renderer/lib/boards/boardSaver';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import type { KanbanBoard, TileDefinition } from '@renderer/schema/index';
import { installMemoryVault } from '../helpers/memoryVault';

const REL = 'Board/Card.md';

function hydrateKanban(): void {
  const def = {
    id: 'c1', type: 'text', filePath: REL,
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    createdAt: 0, updatedAt: 0,
  } as unknown as TileDefinition;
  const fixture: BoardFileData = {
    board: {
      id: 'kb', type: 'kanban', name: 'K', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      columns: [{ id: 'todo', title: 'Todo', tilePlacements: [{ tileId: 'c1' }, { tileId: 'c2' }] }],
    } as unknown as KanbanBoard,
    tileDefs: { c1: def, c2: { ...def, id: 'c2', filePath: 'Board/Other.md' } as TileDefinition },
    connections: {},
    frames: [],
  };
  boardCacheStore.hydrate({ kb: fixture }, { kb: 'k.board.json' });
}

function cardIds(): string[] {
  const board = boardCacheStore.cache.kb?.board as KanbanBoard;
  return (board.columns[0]?.tilePlacements ?? []).map((p) => p.tileId);
}

describe('DeleteCardCommand with the note', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    __resetErrorBusForTests();
    vi.spyOn(uiStore, 'toast').mockImplementation(() => '');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
  });

  it('moves the note to the trash with the card; undo brings both back in their place, redo takes them again', async () => {
    hydrateKanban();
    const bytes = '---\ntitle: Card\ndueDate: 2026-11-02\n---\nThe card\'s text\n';
    const vault = installMemoryVault({ [REL]: bytes, 'Board/Other.md': 'other' });

    const cmd = new DeleteCardCommand('kb', 'c1', { filePath: REL, vaultRoot: '/vault' });
    expect(cmd.description).toBe('Delete card and file');
    await cmd.execute();
    expect(cardIds()).toEqual(['c2']);
    expect(vault.read(REL)).toBeUndefined();
    expect([...vault.trash.values()].map((t) => t.originalPath)).toEqual([REL]);

    await cmd.undo();
    expect(cardIds()).toEqual(['c1', 'c2']);
    expect(vault.read(REL)).toBe(bytes);
    expect(vault.trash.size).toBe(0);

    await cmd.execute();
    expect(cardIds()).toEqual(['c2']);
    expect(vault.read(REL)).toBeUndefined();
  });

  it('a note gone from the trash some other way, its name taken by another note: the card stays off, and a redo leaves that note alone', async () => {
    hydrateKanban();
    const vault = installMemoryVault({ [REL]: 'the card\'s note', 'Board/Other.md': 'other' });
    const cmd = new DeleteCardCommand('kb', 'c1', { filePath: REL, vaultRoot: '/vault' });
    await cmd.execute();
    vault.trash.clear();
    vault.writeExternally(REL, 'a different note');

    await cmd.undo();
    expect(cardIds()).toEqual(['c2']);
    expect(uiStore.toast).toHaveBeenCalledWith(
      `"${REL}" is no longer in Filo's trash, and another file has that name now, so its card was left off.`, 'warning', 8000,
    );
    await cmd.execute();
    expect(vault.read(REL)).toBe('a different note');
    expect(vault.trash.size).toBe(0);
    await cmd.undo();
    expect(cardIds()).toEqual(['c2']);
  });

  it('without the note, removes only the card and touches no file', async () => {
    hydrateKanban();
    const vault = installMemoryVault({ [REL]: 'kept' });
    const cmd = new DeleteCardCommand('kb', 'c1');
    expect(cmd.description).toBe('Delete card');
    await cmd.execute();
    expect(cardIds()).toEqual(['c2']);
    expect(vault.read(REL)).toBe('kept');
    await cmd.undo();
    expect(cardIds()).toEqual(['c1', 'c2']);
    expect(vault.trash.size).toBe(0);
  });
});
