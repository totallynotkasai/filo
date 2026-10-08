/**
 * Kanban's bulk "Add tag" reaches every kind of card: a text card's note, a
 * link card's own tags (on the board), and a recording's file
 * (`.filo/tags.json`). An audio card with nothing recorded yet has nowhere to
 * keep a tag, and the message says so rather than "already have the tag".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KanbanMultiSelect, bulkTagResult } from '@renderer/lib/kanban/kanbanMultiSelect.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { AddPathTagCommand, AddTileTagCommand, BatchCommand } from '@renderer/commands/index';
import type { Command } from '@renderer/commands/Command';
import type { KanbanBoard, Tile } from '@renderer/schema/index';
import type { SelectionScope } from '@renderer/stores/selection.svelte';

const cards: Record<string, Tile> = {
  note: { id: 'note', type: 'text', title: 'Plot', tags: [], filePath: 'Plot.md' } as unknown as Tile,
  link: { id: 'link', type: 'link', title: 'Map', tags: [], url: 'https://example.com' } as unknown as Tile,
  tagged: { id: 'tagged', type: 'link', title: 'Old', tags: ['lore'], url: 'https://example.org' } as unknown as Tile,
  recording: { id: 'recording', type: 'audio', title: 'Voice', tags: [], src: 'Kanban 1/voice.webm' } as unknown as Tile,
  empty: { id: 'empty', type: 'audio', title: 'New Recording', tags: [], src: '' } as unknown as Tile,
};

function multiSelect(selected: string[]): KanbanMultiSelect {
  return new KanbanMultiSelect({
    selection: { selectedIds: new Set(selected) } as unknown as SelectionScope,
    getBoardId: () => 'kb',
    getColumns: () => [] as unknown as KanbanBoard['columns'],
    getAllTilesById: () => cards,
    getFlatVisibleTileIds: () => selected,
    bumpCacheVersion: () => {},
    tickAndPersist: () => {},
    ensureSeededFm: () => null,
    vaultPathForTile: (t: Tile) => (t.type === 'text' ? (t as { filePath: string }).filePath : null),
    promptForTag: () => Promise.resolve('lore'),
  });
}

let executed: Command[];
let toasts: string[];

beforeEach(() => {
  noteStore.__resetForTests();
  historyStore.clear();
  historyStore.setActiveBoard('kb');
  executed = [];
  toasts = [];
  vi.spyOn(historyStore, 'execute').mockImplementation((cmd: Command) => {
    executed.push(cmd);
    return Promise.resolve();
  });
  vi.spyOn(uiStore, 'toast').mockImplementation((text: string) => {
    toasts.push(text);
    return '' as never;
  });
  vi.spyOn(fileTagsStore, 'findTile').mockImplementation((id: string) => cards[id]);
});

afterEach(() => {
  vi.restoreAllMocks();
  historyStore.setActiveBoard(null);
  historyStore.clear();
  noteStore.__resetForTests();
});

function steps(): Command[] {
  const [batch] = executed;
  expect(batch).toBeInstanceOf(BatchCommand);
  return Reflect.get(batch!, 'commands') as Command[];
}

describe('Kanban bulk "Add tag"', () => {
  it('tags a link card on the board and a recording by its file, beside a text card', async () => {
    await multiSelect(['note', 'link', 'recording']).tagSelectedTiles();
    const added = steps();
    expect(added.map((c) => c.constructor)).toEqual([AddPathTagCommand, AddTileTagCommand, AddTileTagCommand]);
    expect(toasts).toEqual(['Added #lore to 3 cards']);
  });

  it('a selection of only link and audio cards is tagged too (never "already have the tag")', async () => {
    await multiSelect(['link', 'recording']).tagSelectedTiles();
    expect(steps()).toHaveLength(2);
    expect(toasts).toEqual(['Added #lore to 2 cards']);
  });

  it('says why an audio card with nothing recorded yet was skipped', async () => {
    await multiSelect(['link', 'empty']).tagSelectedTiles();
    expect(steps()).toHaveLength(1);
    expect(toasts[0]).toBe('Added #lore to 1 card. Skipped: 1 audio card has nothing recorded yet (a recording keeps its tags with its file).');

    executed = [];
    toasts = [];
    await multiSelect(['tagged', 'empty']).tagSelectedTiles();
    expect(executed).toEqual([]);
    expect(toasts[0]).toBe("#lore wasn't added: 1 card already has it, and 1 audio card has nothing recorded yet (a recording keeps its tags with its file).");
  });

  it('cards that all carry the tag already say so', async () => {
    await multiSelect(['tagged']).tagSelectedTiles();
    expect(executed).toEqual([]);
    expect(toasts).toEqual(['All selected cards already have #lore']);
  });
});

describe('bulkTagResult', () => {
  it('counts in plain words', () => {
    expect(bulkTagResult('x', 1, { already: 0, noFile: 0 })).toBe('Added #x to 1 card');
    expect(bulkTagResult('x', 0, { already: 0, noFile: 2 })).toBe("#x wasn't added: 2 audio cards have nothing recorded yet (a recording keeps its tags with its file).");
  });
});
