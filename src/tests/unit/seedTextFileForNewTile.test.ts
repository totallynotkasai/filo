/**
 * A new text tile gets its note in two steps: `stampTextTileSeedPath` picks
 * the path synchronously (so the cached def names it at once), then
 * `seedTextFileForNewTile` creates the file. The rules pinned here:
 *  - a brand-new note is created exclusively with its `title:`, and follows
 *    the name the writer actually got if another file took the pick;
 *  - a note the tile already names (a drop, a restore) is adopted untouched
 *    when it exists, and never materialised as a blank file on a
 *    cascade-delete undo;
 *  - a failure is reported, never thrown into the add.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { stampTextTileSeedPath, seedTextFileForNewTile } from '@renderer/lib/boards/seedTextFileForNewTile';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardDefaults } from '@renderer/core/boardDefaults';
import { TileSchema, TextTileDefSchema, type Tile } from '@renderer/schema/index';
import { readNoteText } from '@renderer/lib/notes/noteFile';
import { onError, type ReportedError } from '@renderer/lib/utils/errorBus';

const reported: ReportedError[] = [];
let stopListening: () => void = () => undefined;

function tile(fields: { id?: string; type?: 'text' | 'link'; title?: string; filePath?: string; content?: string } = {}): Tile {
  const base = {
    id: fields.id ?? 't1',
    boardId: 'mm',
    title: fields.title ?? 'Idea',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: { headerColor: '', bodyColor: '' },
    createdAt: 0,
    updatedAt: 0,
  };
  if (fields.type === 'link') return TileSchema.parse({ ...base, type: 'link', url: 'https://example.com' });
  return TileSchema.parse({
    ...base,
    type: 'text',
    content: fields.content ?? '',
    ...(fields.filePath ? { filePath: fields.filePath } : {}),
  });
}

function filePathOf(t: Tile): string | undefined {
  return t.type === 'text' ? t.filePath : undefined;
}

/** A board whose text tiles already use `paths`. */
function hydrateBoardWith(paths: string[]): void {
  const tileDefs = Object.fromEntries(
    paths.map((p, i) => [`d${i}`, TextTileDefSchema.parse({ id: `d${i}`, type: 'text', filePath: p, style: { headerColor: '', bodyColor: '' }, createdAt: 0, updatedAt: 0 })]),
  );
  boardCacheStore.hydrate(
    { mm: { board: boardDefaults.mindmap('mm', 'Map'), tileDefs, connections: {}, frames: [] } },
    { mm: 'Map.board.json' },
  );
}

let createUnique: MockInstance<(typeof noteStore)['createUnique']>;
let createExclusive: MockInstance<(typeof noteStore)['createExclusive']>;
let refreshTree: MockInstance<(typeof vaultStore)['refreshTree']>;
let persistUpdateTile: MockInstance<(typeof boardCacheStore)['persistUpdateTile']>;

beforeEach(() => {
  reported.length = 0;
  stopListening = onError((e) => { reported.push(e); });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vaultStore.setPath('/vault');
  boardCacheStore.clear();
  hydrateBoardWith([]);
  createUnique = vi.spyOn(noteStore, 'createUnique').mockImplementation(async (first, build) => ({
    relPath: first,
    stem: first.replace(/\.md$/, ''),
    text: build(first.replace(/\.md$/, '')),
  }));
  createExclusive = vi.spyOn(noteStore, 'createExclusive').mockResolvedValue('created');
  refreshTree = vi.spyOn(vaultStore, 'refreshTree').mockResolvedValue(true);
  persistUpdateTile = vi.spyOn(boardCacheStore, 'persistUpdateTile').mockImplementation(() => undefined);
});

afterEach(() => {
  stopListening();
  vi.restoreAllMocks();
  boardCacheStore.clear();
  vaultStore.setPath('');
});

describe('stampTextTileSeedPath', () => {
  it('picks <title>.md in the vault root and stamps it on the tile', () => {
    const t = tile({ title: 'Idea' });
    expect(stampTextTileSeedPath(t, 'mm')).toBe('Idea.md');
    expect(filePathOf(t)).toBe('Idea.md');
  });

  it('keeps a path the tile already names', () => {
    const t = tile({ filePath: 'Notes/Existing.md' });
    expect(stampTextTileSeedPath(t, 'mm')).toBe('Notes/Existing.md');
  });

  it('bumps past a path another text tile already uses, case-insensitively', () => {
    hydrateBoardWith(['idea.md']);
    const t = tile({ title: 'Idea' });
    expect(stampTextTileSeedPath(t, 'mm')).toBe('Idea (2).md');
  });

  it('turns characters a file name cannot hold into safe ones', () => {
    const t = tile({ title: 'a/b:c?' });
    const picked = stampTextTileSeedPath(t, 'mm') ?? '';
    expect(picked.endsWith('.md')).toBe(true);
    expect(picked).not.toMatch(/[/:?]/);
  });

  it('uses Untitled for a tile with no title', () => {
    expect(stampTextTileSeedPath(tile({ title: '' }), 'mm')).toBe('Untitled.md');
  });

  it('puts the note in the pinned Root Directory', () => {
    vi.spyOn(vaultStore, 'activeRootFolder', 'get').mockReturnValue('Inbox');
    expect(stampTextTileSeedPath(tile({ title: 'Idea' }), 'mm')).toBe('Inbox/Idea.md');
  });

  it('returns null for a non-text tile and for no open vault', () => {
    expect(stampTextTileSeedPath(tile({ type: 'link' }), 'mm')).toBeNull();
    vaultStore.setPath('');
    const t = tile();
    expect(stampTextTileSeedPath(t, 'mm')).toBeNull();
    expect(filePathOf(t)).toBeUndefined();
  });
});

describe('seedTextFileForNewTile: a brand-new note', () => {
  it('creates it exclusively with its title and first body, then refreshes the tree', async () => {
    const t = tile({ title: 'Idea', content: 'First line' });
    await seedTextFileForNewTile(t, 'mm');

    expect(createUnique).toHaveBeenCalledTimes(1);
    expect(createUnique.mock.calls[0][0]).toBe('Idea.md');
    const text = createUnique.mock.results[0].type === 'return' ? (await createUnique.mock.results[0].value).text : '';
    const parsed = readNoteText(text);
    expect(parsed.frontmatter.title).toBe('Idea');
    expect(parsed.body.trim()).toBe('First line');
    expect(createExclusive).not.toHaveBeenCalled();
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(persistUpdateTile).not.toHaveBeenCalled();
  });

  it('follows the name the writer got when another file took the pick', async () => {
    createUnique.mockImplementation(async (_first, build) => ({ relPath: 'Idea (2).md', stem: 'Idea (2)', text: build('Idea (2)') }));
    const t = tile({ id: 'tX', title: 'Idea' });

    await seedTextFileForNewTile(t, 'mm');

    expect(filePathOf(t)).toBe('Idea (2).md');
    expect(persistUpdateTile).toHaveBeenCalledWith('tX', { filePath: 'Idea (2).md' }, 'mm');
  });

  it('creates a note with a stamped path the same way when stamped first', async () => {
    const t = tile({ title: 'Idea' });
    stampTextTileSeedPath(t, 'mm');
    await seedTextFileForNewTile(t, 'mm');
    expect(createUnique).toHaveBeenCalledTimes(1);
    expect(createExclusive).not.toHaveBeenCalled();
  });

  it('reports a failed create instead of throwing, naming the file', async () => {
    const err = new Error('disk full');
    createUnique.mockRejectedValue(err);
    const t = tile({ title: 'Idea' });

    await expect(seedTextFileForNewTile(t, 'mm')).resolves.toBeUndefined();

    expect(reported).toHaveLength(1);
    expect(reported[0].error).toBe(err);
    expect(reported[0].path).toBe('Idea.md');
    expect(refreshTree).not.toHaveBeenCalled();
  });
});

describe('seedTextFileForNewTile: a note the tile already names', () => {
  it('adopts an existing file untouched (no tree refresh, no rename)', async () => {
    createExclusive.mockResolvedValue('exists');
    const t = tile({ filePath: 'Dropped.md', title: 'Dropped' });

    await seedTextFileForNewTile(t, 'mm');

    expect(createExclusive).toHaveBeenCalledTimes(1);
    expect(createExclusive.mock.calls[0][0]).toBe('Dropped.md');
    expect(createUnique).not.toHaveBeenCalled();
    expect(refreshTree).not.toHaveBeenCalled();
    expect(filePathOf(t)).toBe('Dropped.md');
  });

  it('creates a missing one with its title and refreshes the tree', async () => {
    const t = tile({ filePath: 'Sub/Named.md', title: 'Named' });
    await seedTextFileForNewTile(t, 'mm');
    const text = createExclusive.mock.calls[0][1];
    expect(readNoteText(text).frontmatter.title).toBe('Named');
    expect(refreshTree).toHaveBeenCalledTimes(1);
  });

  it('leaves an absent file absent on a cascade-delete undo (skipEmptySeed)', async () => {
    const t = tile({ filePath: 'Gone.md' });
    await seedTextFileForNewTile(t, 'mm', { skipEmptySeed: true });
    expect(createExclusive).not.toHaveBeenCalled();
    expect(createUnique).not.toHaveBeenCalled();
  });

  it('skipEmptySeed does not stop a brand-new note from being created', async () => {
    await seedTextFileForNewTile(tile({ title: 'Idea' }), 'mm', { skipEmptySeed: true });
    expect(createUnique).toHaveBeenCalledTimes(1);
  });
});

describe('seedTextFileForNewTile: nothing to do', () => {
  it('ignores a non-text tile', async () => {
    await seedTextFileForNewTile(tile({ type: 'link' }), 'mm');
    expect(createUnique).not.toHaveBeenCalled();
    expect(createExclusive).not.toHaveBeenCalled();
  });

  it('ignores a tile with no vault open', async () => {
    vaultStore.setPath('');
    await seedTextFileForNewTile(tile(), 'mm');
    expect(createUnique).not.toHaveBeenCalled();
    expect(createExclusive).not.toHaveBeenCalled();
  });
});
