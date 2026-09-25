import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { makeKanbanFrontmatterWriter } from '@renderer/lib/kanban/kanbanFrontmatterWriter';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard as KanbanBoardType, Tile } from '@renderer/schema/index';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A Kanban field edit on a card no view has open → the bytes on disk.
 *
 * "Never drop an untouched key" is structural: the edit goes to the note
 * writer as a delta, applied to a FRESH read of the file. These tests leave
 * the vault index STALE (primed before another program changed the file) and
 * assert that whatever the file holds — an externally-added key, an empty
 * key, a full datetime, a comment, key order, even a malformed block —
 * survives the edit. That can only happen if the write reads disk, not a
 * cached copy.
 */

function hydrateBoardWithTextTile(
  boardId: string,
  defs: Array<{ tileId: string; title: string }>,
): void {
  const tileDefs: Record<string, unknown> = {};
  for (const d of defs) {
    tileDefs[d.tileId] = {
      id: d.tileId,
      type: 'text',
      filePath: `${d.title}.md`,
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
  }
  const data = {
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
    },
    tileDefs: tileDefs as V7BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  } as unknown as V7BoardFileData;
  boardCacheStore.hydrate({ [boardId]: data }, { [boardId]: `${boardId}.board.json` });
}

/** Drives a Kanban field edit on a not-open card. */
function makeWriter(tile: Tile): ReturnType<typeof makeKanbanFrontmatterWriter> {
  return makeKanbanFrontmatterWriter({
    getBoard: () => ({ id: 'kb', type: 'kanban', columns: [] }) as unknown as KanbanBoardType,
    getAllTilesById: () => ({ [tile.id]: tile }),
    bumpCacheVersion: () => {},
    tickAndPersist: () => {},
  });
}

describe('field edit applies a delta to FRESH disk (stale index)', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vault = installMemoryVault();
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

  /**
   * Puts `stale` in the vault index for `rel` and `onDisk` in the file — the
   * state after another program changed the file and before the index caught up.
   */
  function staleIndex(rel: string, stale: string, onDisk: string): void {
    vaultIndexStore.restoreMetadata(rel, parseMarkdown(rel, stale));
    vault.writeExternally(rel, onDisk);
  }

  async function fieldEditAndFlush(tile: Tile, patch: Record<string, unknown>): Promise<void> {
    await makeWriter(tile).updateTileFrontmatter(tile.id, patch);
    await noteStore.flushAll();
  }

  it('preserves an externally-added key the stale index never saw', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', title: 'Card' }]);
    staleIndex(
      'Card.md',
      '---\ncompleted: false\n---\ncard body\n',
      '---\ncompleted: false\nstatus: blocked\n---\ncard body\n',
    );

    const tile = { id: 't1', type: 'text', filePath: 'Card.md', title: 'Card', tags: [] } as unknown as Tile;
    await fieldEditAndFlush(tile, { completed: true });

    expect(vault.read('Card.md')).toBe('---\ncompleted: true\nstatus: blocked\n---\ncard body\n');
  });

  it('preserves a present-but-empty disk key (aliases:) through an unrelated field edit', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', title: 'Note' }]);
    staleIndex('Note.md', '---\ncompleted: false\n---\nbody\n', '---\naliases:\ncompleted: false\n---\nbody\n');

    const tile = { id: 't1', type: 'text', filePath: 'Note.md', title: 'Note', tags: [] } as unknown as Tile;
    await fieldEditAndFlush(tile, { priority: 'high' });

    const written = vault.read('Note.md') ?? '';
    expect(written).toContain('priority: high');
    expect(written).toContain('aliases:'); // the empty key was NOT stripped
    expect(written).toContain('completed: false');
  });

  it('preserves a full datetime on an untouched key', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', title: 'Event' }]);
    staleIndex(
      'Event.md',
      '---\ncompleted: false\n---\nbody\n',
      '---\ncreated: 2025-01-15T10:30:00Z\ncompleted: false\n---\nbody\n',
    );

    const tile = { id: 't1', type: 'text', filePath: 'Event.md', title: 'Event', tags: [] } as unknown as Tile;
    await fieldEditAndFlush(tile, { completed: true });

    const written = vault.read('Event.md') ?? '';
    expect(written).toContain('created: 2025-01-15T10:30:00Z'); // full datetime, not truncated
    expect(written).toContain('completed: true');
  });

  it('preserves a comment + key order on untouched keys', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', title: 'Doc' }]);
    staleIndex(
      'Doc.md',
      '---\ncompleted: false\n---\nbody\n',
      '---\n# important note\nzeta: 1\ncompleted: false\nalpha: 2\n---\nbody\n',
    );

    const tile = { id: 't1', type: 'text', filePath: 'Doc.md', title: 'Doc', tags: [] } as unknown as Tile;
    await fieldEditAndFlush(tile, { completed: true });

    expect(vault.read('Doc.md')).toBe('---\n# important note\nzeta: 1\ncompleted: true\nalpha: 2\n---\nbody\n');
  });

  it('does NOT destroy an unparseable (malformed) frontmatter block', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', title: 'Bad' }]);
    const bad = '---\n\tbad: yaml\n  dup: 1\n  dup: 2\n---\nbody\n';
    staleIndex('Bad.md', '---\n---\nbody\n', bad);

    const tile = { id: 't1', type: 'text', filePath: 'Bad.md', title: 'Bad', tags: [] } as unknown as Tile;
    await fieldEditAndFlush(tile, { priority: 'high' });

    // Data-safe: the broken-but-present block is kept verbatim rather than
    // replaced by a dump of just the new key (total-FM-loss class).
    expect(vault.read('Bad.md')).toBe(bad);
  });
});
