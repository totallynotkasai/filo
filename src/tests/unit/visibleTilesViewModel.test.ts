import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Audit-10 M6 — `VisibleTilesViewModel.visibleTiles` was rewritten to map over
 * the culled `visibleTileIds` (O(on-screen)) instead of filtering every tile on
 * the board (O(total) per pan frame). These tests pin the observable contract
 * the refactor must preserve: correct viewport culling, frame-hidden exclusion,
 * export-mode behaviour, and — critically — insertion-order stacking, so
 * overlapping tiles sharing the `--z-tile` z-index keep their DOM-order paint
 * order even though the spatial index returns ids in tree-traversal order.
 *
 * `framesStore` is a facade over the active board scope; we mock it so the view
 * model can be exercised with plain mock deps and a controllable hidden set.
 */
const { mockHidden } = vi.hoisted(() => ({ mockHidden: new Set<string>() }));
vi.mock('@renderer/stores/frames.svelte', () => ({
  framesStore: {
    get hiddenTileIds() {
      return mockHidden;
    },
  },
}));

import { VisibleTilesViewModel } from '@renderer/lib/mindmap/visibleTilesViewModel.svelte';
import type { Tile } from '@renderer/schema/index';

function tile(id: string): Tile {
  return { id } as unknown as Tile;
}

function makeViewModel(
  tiles: Record<string, Tile>,
  visibleIds: string[],
  exportMode = false,
): VisibleTilesViewModel {
  const deps = {
    board: { tiles, current: { type: 'mindmap' }, frames: [] },
    canvas: {
      viewportRect: { left: 0, top: 0, right: 1000, bottom: 1000 },
      exportMode,
    },
    spatial: { queryViewport: () => visibleIds },
  };
  return new VisibleTilesViewModel(deps as never);
}

describe('VisibleTilesViewModel.visibleTiles (Audit-10 M6)', () => {
  beforeEach(() => {
    mockHidden.clear();
  });

  it('culls to the spatial viewport set (only on-screen tiles)', () => {
    const tiles = { a: tile('a'), b: tile('b'), c: tile('c') };
    const vm = makeViewModel(tiles, ['a', 'c']);
    expect(vm.visibleTiles.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('preserves insertion-order stacking regardless of spatial query order', () => {
    // board.tiles inserted a,b,c; the spatial index returns them reversed. The
    // result must come back in insertion order so overlapping same-z-index tiles
    // keep their current stacking (DOM order = paint order).
    const tiles = { a: tile('a'), b: tile('b'), c: tile('c') };
    const vm = makeViewModel(tiles, ['c', 'b', 'a']);
    expect(vm.visibleTiles.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('excludes frame-hidden tiles even when they are in the viewport set', () => {
    mockHidden.add('b');
    const tiles = { a: tile('a'), b: tile('b'), c: tile('c') };
    const vm = makeViewModel(tiles, ['a', 'b', 'c']);
    expect(vm.visibleTiles.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('ignores a stale visible id with no backing tile', () => {
    const tiles = { a: tile('a') };
    const vm = makeViewModel(tiles, ['a', 'ghost']);
    expect(vm.visibleTiles.map((t) => t.id)).toEqual(['a']);
  });

  it('export mode renders every tile (culling disabled), minus frame-hidden', () => {
    mockHidden.add('b');
    const tiles = { a: tile('a'), b: tile('b'), c: tile('c') };
    // Empty visible set is ignored in export mode — all tiles render.
    const vm = makeViewModel(tiles, [], true);
    expect(vm.visibleTiles.map((t) => t.id)).toEqual(['a', 'c']);
  });
});
