import { describe, it, expect, vi, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { makeTilesSlice } from '@renderer/stores/boardTiles';
import type { BoardContext } from '@renderer/stores/boardStoreTypes';
import type { Tile } from '@renderer/schema/index';

/**
 * `addTile` / `batchUpdateTiles` previously `console.warn`-ed on a
 * failed `TileSchema.safeParse` and then persisted the invalid tile anyway. A
 * malformed tile reaching `.board.json` is silently dropped by `loadBoard` on
 * the next open, losing the placement (and any inline Link/Iframe/Timer data).
 * The sibling `updateTile` already hard-rejects; these tests lock that same
 * behaviour into the add / batch paths so a Zod-invalid tile never reaches the
 * cache, and assert the user is told via a one-shot toast.
 */

function makeValidTile(over: Partial<Tile> = {}): Tile {
  return {
    id: 'tile00000001',
    boardId: 'board1',
    type: 'text',
    title: 'Note',
    filePath: 'Note.md',
    content: '',
    position: { x: 10, y: 20 },
    size: { width: 240, height: 160 },
    style: { headerColor: '#000000', bodyColor: '#ffffff' },
    tags: [],
    locked: false,
    faded: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  } as Tile;
}

/**
 * Geometry stays valid (so the pre-fix path would have run `spatial.insert`
 * and then persisted) but a required, default-less field is missing, so
 * `TileSchema.safeParse` fails.
 */
function makeInvalidTile(): Tile {
  const t = makeValidTile() as Partial<Tile>;
  delete t.createdAt;
  delete t.updatedAt;
  return t as Tile;
}

function makeCtx(tiles: Record<string, Tile> = {}): {
  ctx: BoardContext;
  spatial: {
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
} {
  const spatial = { insert: vi.fn(), update: vi.fn(), remove: vi.fn() };
  const ctx = {
    getCurrent: () => ({ id: 'board1' }),
    getTiles: () => tiles,
    spatial,
  } as unknown as BoardContext;
  return { ctx, spatial };
}

describe('boardTiles — invalid tiles are never persisted', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('addTile drops a Zod-invalid tile: no persist, no spatial insert, warns once', async () => {
    const addSpy = vi.spyOn(boardCacheStore, 'persistAddTile').mockResolvedValue(true);
    const toastSpy = vi.spyOn(uiStore, 'toast').mockImplementation(() => undefined as never);
    const { ctx, spatial } = makeCtx();
    await makeTilesSlice(ctx).addTile(makeInvalidTile());
    expect(addSpy).not.toHaveBeenCalled();
    expect(spatial.insert).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it('addTile persists a valid tile', async () => {
    const addSpy = vi.spyOn(boardCacheStore, 'persistAddTile').mockResolvedValue(true);
    const { ctx } = makeCtx();
    await makeTilesSlice(ctx).addTile(makeValidTile());
    expect(addSpy).toHaveBeenCalledTimes(1);
  });

  it('batchUpdateTiles skips an update whose merged tile is invalid', () => {
    const updSpy = vi.spyOn(boardCacheStore, 'persistUpdateTile').mockImplementation(() => {});
    const toastSpy = vi.spyOn(uiStore, 'toast').mockImplementation(() => undefined as never);
    const existing = makeValidTile();
    const { ctx } = makeCtx({ [existing.id]: existing });
    // width 0 fails SizeSchema.min(80), so the merged tile is invalid.
    makeTilesSlice(ctx).batchUpdateTiles([
      { id: existing.id, changes: { size: { width: 0, height: 160 } } as Partial<Tile> },
    ]);
    expect(updSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it('batchUpdateTiles persists a valid update', () => {
    const updSpy = vi.spyOn(boardCacheStore, 'persistUpdateTile').mockImplementation(() => {});
    const toastSpy = vi.spyOn(uiStore, 'toast').mockImplementation(() => undefined as never);
    const existing = makeValidTile();
    const { ctx } = makeCtx({ [existing.id]: existing });
    makeTilesSlice(ctx).batchUpdateTiles([
      { id: existing.id, changes: { position: { x: 99, y: 99 } } as Partial<Tile> },
    ]);
    expect(updSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
