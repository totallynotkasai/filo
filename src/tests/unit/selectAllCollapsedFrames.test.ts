import { describe, it, expect, afterEach } from 'vitest';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  requestDeleteSelected,
  selectableTileIds,
  type DeleteSelectionDeps,
} from '@renderer/lib/mindmap/selectionActions';
import type { Tile } from '@renderer/schema/index';

/**
 * Ctrl+A selects only tiles the canvas draws: a tile inside a collapsed frame
 * is hidden, so it isn't selected (Delete would remove what the user can't
 * see). A selection that still holds hidden tiles says so in the confirm.
 */

function tile(id: string): Tile {
  return { id, type: 'link', title: id } as unknown as Tile;
}

function deps(ids: string[], hidden: string[]): DeleteSelectionDeps {
  const tiles = new Map(ids.map((id) => [id, tile(id)]));
  return {
    board: {
      getTile: (id) => tiles.get(id),
      removeTilesWithHistory: () => {},
      removeConnectionWithHistory: () => {},
    },
    selection: {
      selectedIds: new Set(ids),
      selectedConnectionIds: new Set(),
      clear: () => {},
      clearConnections: () => {},
    },
    vaultPath: () => null,
    hiddenTileIds: () => new Set(hidden),
  };
}

afterEach(() => {
  uiStore.closeConfirm();
});

describe('select all and collapsed frames', () => {
  it('leaves out tiles inside a collapsed frame', () => {
    const tiles = { a: tile('a'), b: tile('b'), c: tile('c') };
    expect(selectableTileIds(tiles, new Set(['b']))).toEqual(['a', 'c']);
  });

  it('the delete confirm names tiles hidden in collapsed frames', () => {
    requestDeleteSelected(deps(['a', 'b', 'c'], ['b', 'c']));
    expect(uiStore.confirmDialog?.body).toContain('2 of them are inside collapsed frames');
  });

  it('says nothing extra when every selected tile is shown', () => {
    requestDeleteSelected(deps(['a'], ['z']));
    expect(uiStore.confirmDialog?.body).not.toContain('collapsed');
  });
});
