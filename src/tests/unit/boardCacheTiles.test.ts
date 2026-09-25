import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Tile, MindMapBoard } from '@renderer/schema/index';

/**
 * Tile-persistence regression: `persistAddTile` originally trusted
 * `tile.boardId` unconditionally — if a tile was constructed while
 * `boardStore.current` was momentarily null (drag-drop in flight, template
 * insertion racing with a tab switch), the empty string flowed through and
 * the `if (!cached) return;` guard at the end silently dropped the entire
 * tile.
 *
 * The fix is two-pronged: `boardStore.addTile` now stamps `boardId` from
 * `currentBoard?.id` when the inbound tile lacks one, AND `persistAddTile`
 * falls back to `findBoardIdForTile` for re-adds (e.g. undo→redo cycles).
 *
 * These tests cover the cache-side fallback. The stamping at boardStore is
 * exercised by integration tests (manual smoke).
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler> = {}): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function makeNonTextTile(id: string, boardId: string): Tile {
  // 'link' tile — has no .md backing file, so persistAddTile skips the
  // markdown-write branch entirely and we don't need to stub vault IPC.
  return {
    id,
    boardId,
    type: 'link',
    title: 'Example',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: {} as never,
    tags: [],
    locked: false,
    faded: false,
    url: 'https://example.com',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Tile;
}

function makeMindMapFixture(
  initialDefs: Record<string, unknown> = {},
  initialPlacements: Record<string, unknown> = {},
): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: initialPlacements,
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: initialDefs as BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  };
}

describe('boardCache — tile persistence', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
  });
  afterEach(() => boardCacheStore.clear());

  it('persistAddTile with empty boardId AND no cache match warns and drops', async () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const orphan = makeNonTextTile('t-orphan', '');
    await boardCacheStore.persistAddTile(orphan);

    expect(boardCacheStore.cache.mm.tileDefs['t-orphan']).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('persistAddTile: cannot resolve boardId'),
    );
    warn.mockRestore();
  });

  it('persistAddTile resolves boardId via cache scan when the tile def exists in some board', async () => {
    // Re-add scenario: the tile def is already in the cache (e.g. from an
    // earlier add, then an undo that retained the def). The re-add inbound
    // copy arrives with boardId=''.
    const seededDef = {
      id: 't1',
      type: 'link',
      title: 'Existing',
      style: {},
      tags: [],
      createdAt: 0,
      updatedAt: 0,
      url: 'https://x',
    };
    boardCacheStore.hydrate(
      {
        mm: makeMindMapFixture(
          { t1: seededDef as never },
          { t1: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false } },
        ),
      },
      { mm: 'map.board.json' },
    );

    const reAdded = makeNonTextTile('t1', '');
    await boardCacheStore.persistAddTile(reAdded);

    // The tile def now reflects the re-added link tile, written into board 'mm'
    // because findBoardIdForTile('t1') located it there.
    expect(boardCacheStore.cache.mm.tileDefs.t1).toBeDefined();
  });

  it('persistAddTile with explicit boardId persists into that board (happy path)', async () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );

    const tile = makeNonTextTile('t-new', 'mm');
    await boardCacheStore.persistAddTile(tile);

    expect(boardCacheStore.cache.mm.tileDefs['t-new']).toBeDefined();
  });

  // 6.4.M20 — cascade-delete rollback re-adds a tile that is NOT in any board's
  // cache yet and may carry no boardId, so the findBoardIdForTile memo scan
  // invalidates its stale entry and resolves nothing → the re-add was dropped.
  // CascadeDeleteCommand.undo now passes the boardId it already knows via the
  // explicit-boardId arg.
  it('persistAddTile honors an explicit boardId arg for a tile not yet in any board', async () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );

    const reAdded = makeNonTextTile('t-readd', ''); // empty boardId, not in cache
    await boardCacheStore.persistAddTile(reAdded, { skipEmptySeed: true }, 'mm');

    expect(boardCacheStore.cache.mm.tileDefs['t-readd']).toBeDefined();
  });
});

describe('boardCache — persistAddTile stamps filePath on text tiles', () => {
  /**
   * Regression: convention-backed text tiles used to leave the def without
   * a `filePath`, leaving their identity bound to whatever `activeRootFolder`
   * was current at resolution time. Toggling Root Directory would then shift
   * the convention path under existing tiles and false-flag the broken-ref
   * indicator. The fix stamps the resolved filename onto the def on first
   * write so the tile remembers its actual file location.
   */
  beforeEach(() => {
    installFiloStub({
      'vault:file-exists': async () => false,
      'vault:write-file-text': async () => undefined,
      'vault:read-tree': async () => ({ ok: true, tree: [] }),
    });
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    vi.restoreAllMocks();
  });

  function makeTextTile(id: string, title: string): Tile {
    return {
      id,
      boardId: 'mm',
      type: 'text',
      title,
      position: { x: 0, y: 0 },
      size: { width: 200, height: 100 },
      style: {} as never,
      tags: [],
      locked: false,
      faded: false,
      content: '',
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Tile;
  }

  it('stamps filePath = `${title}.md` when no Root Directory is pinned', async () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );

    const tile = makeTextTile('t-foo', 'Foo');
    await boardCacheStore.persistAddTile(tile);

    const def = boardCacheStore.cache.mm.tileDefs['t-foo'] as Record<string, unknown>;
    expect(def).toBeDefined();
    expect(def.filePath).toBe('Foo.md');
  });

  it('stamps filePath using the pinned Root Directory when one is active', async () => {
    // `vaultStore.activeRootFolder` is a getter backed by the current project's
    // settings; spy on it to simulate the user having pinned a root.
    const spy = vi
      .spyOn(vaultStore, 'activeRootFolder', 'get')
      .mockReturnValue('Notes');
    try {
      boardCacheStore.hydrate(
        { mm: makeMindMapFixture() },
        { mm: 'map.board.json' },
      );

      const tile = makeTextTile('t-bar', 'Bar');
      await boardCacheStore.persistAddTile(tile);

      const def = boardCacheStore.cache.mm.tileDefs['t-bar'] as Record<string, unknown>;
      expect(def).toBeDefined();
      expect(def.filePath).toBe('Notes/Bar.md');
    } finally {
      spy.mockRestore();
    }
  });

  it('mutates the caller-supplied tile reference so the active store sees filePath immediately', async () => {
    // boardStore.addTile reads tile.filePath after awaiting persistAddTile,
    // so the stamp must mutate the SAME object the caller passed in — not
    // only the persisted def.
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );

    const tile = makeTextTile('t-baz', 'Baz');
    await boardCacheStore.persistAddTile(tile);

    expect((tile as unknown as { filePath?: string }).filePath).toBe('Baz.md');
  });
});
