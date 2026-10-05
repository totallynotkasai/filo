/**
 * New tiles from the Mind Map side toolbar used to land on one spot (the
 * middle of the view, give or take 50 px), so five new tiles were one pile.
 * Each now steps clear of the tiles already there. Mounts the real toolbar
 * inside a board scope whose tiles are the ones it made.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import SideToolbar from '@renderer/components/boards/SideToolbar.svelte';
import { BOARD_SCOPE_KEY } from '@renderer/lib/boards/boardScope.svelte';
import { workspaceStore } from '@renderer/stores/workspace.svelte';
import type { Tile } from '@renderer/schema/index';

let instance: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  workspaceStore.reset();
  document.body.innerHTML = '';
});

function mountToolbar(existing: Tile[] = []): { tiles: Tile[]; root: HTMLElement } {
  const tiles: Tile[] = [...existing];
  const target = document.createElement('div');
  document.body.appendChild(target);
  const scope = {
    board: {
      current: { id: 'mm' },
      get tiles(): Record<string, Tile> {
        return Object.fromEntries(tiles.map((t) => [t.id, t]));
      },
      connections: [],
      groups: [],
      getNextTileName: () => `Tile ${tiles.length + 1}`,
      addTileWithHistory: (tile: Tile) => { tiles.push(tile); },
      addFrameWithHistory: () => {},
    },
    canvas: {
      viewportRect: { left: 0, top: 0, width: 1200, height: 800 },
      snapEnabled: false,
      minimapVisible: true,
      waypointsVisible: true,
      semanticZoomEnabled: true,
    },
    selection: { selectedIds: new Set<string>() },
  };
  instance = mount(SideToolbar, { target, context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, scope]]) });
  flushSync();
  return { tiles, root: target };
}

function newTile(root: HTMLElement, label: string): void {
  root.querySelector<HTMLButtonElement>('button[title="New Tile (Ctrl+N)"]')?.click();
  flushSync();
  const item = [...root.querySelectorAll<HTMLButtonElement>('.dropdown-item')].find((b) => b.textContent?.trim() === label);
  if (!item) throw new Error(`no "${label}" item`);
  item.click();
  flushSync();
}

function overlap(a: Tile, b: Tile): boolean {
  return a.position.x < b.position.x + b.size.width && b.position.x < a.position.x + a.size.width
    && a.position.y < b.position.y + b.size.height && b.position.y < a.position.y + a.size.height;
}

describe('Mind Map side toolbar: new tiles step clear of each other', () => {
  it('the first tile is centred in the view; the next ones overlap none before them', () => {
    const { tiles, root } = mountToolbar();
    for (const label of ['Text', 'Text', 'Link', 'Timer', 'Text']) newTile(root, label);
    expect(tiles).toHaveLength(5);
    const first = tiles[0]!;
    expect(first.position.x + first.size.width / 2).toBe(600);
    expect(first.position.y + first.size.height / 2).toBe(400);
    for (let a = 0; a < tiles.length; a++) {
      for (let b = a + 1; b < tiles.length; b++) expect(overlap(tiles[a]!, tiles[b]!), `${a} and ${b}`).toBe(false);
    }
  });
});
