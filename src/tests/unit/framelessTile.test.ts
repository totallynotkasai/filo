/**
 * Frameless (media-only) tile mode.
 *
 * `frameless` is a per-placement display toggle (mirrors `faded`) that hides a
 * media tile's header / border / shadow / background so only the media shows.
 * These tests pin:
 *   - the schema default + round-trip (placement + runtime tile), and
 *   - ToggleFramelessCommand execute/undo across a mixed selection — which
 *     exercises the full cache round-trip (placement.frameless → getFullTiles),
 *     proving the persistence wiring matches `faded`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { ToggleFramelessCommand } from '@renderer/commands/index';
import { TilePlacementSchema, ImageTileSchema } from '@renderer/schema/index';
import type { Tile, MindMapBoard } from '@renderer/schema/index';
import { seedBoard } from '../helpers/seedBoard';

describe('frameless schema', () => {
  it('defaults frameless to false on a placement', () => {
    const p = TilePlacementSchema.parse({ x: 0, y: 0, width: 120, height: 90 });
    expect(p.frameless).toBe(false);
  });

  it('round-trips frameless:true on a placement', () => {
    const p = TilePlacementSchema.parse({ x: 0, y: 0, width: 120, height: 90, frameless: true });
    expect(p.frameless).toBe(true);
  });

  it('image tile schema accepts frameless (optional on the runtime tile)', () => {
    const base = {
      id: 'a', boardId: 'b', type: 'image' as const, src: 'a.gif',
      title: 'a', position: { x: 0, y: 0 }, size: { width: 120, height: 90 },
      style: { headerColor: '', bodyColor: '' }, createdAt: 0, updatedAt: 0,
    };
    // Optional on the tile (placement owns the persisted default), so absent
    // parses to undefined; readers treat that as "framed".
    expect(ImageTileSchema.parse(base).frameless).toBeUndefined();
    expect(ImageTileSchema.parse({ ...base, frameless: true }).frameless).toBe(true);
  });
});

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeImageTile(id: string, frameless: boolean): Tile {
  return {
    id,
    type: 'image',
    title: id,
    boardId: 'b',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    locked: false,
    faded: false,
    frameless,
    tags: [],
    src: `${id}.gif`,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Tile;
}

function activate(tiles: Tile[]): void {
  const board: MindMapBoard = {
    id: 'b',
    type: 'mindmap',
    name: 'B',
    emoji: '',
    createdAt: 0,
    updatedAt: 0,
    settings: {},
    placements: {},
    inlineTiles: {},
    waypoints: [],
  } as unknown as MindMapBoard;
  const byId: Record<string, Tile> = {};
  for (const t of tiles) byId[t.id] = t;
  seedBoard(boardStore, board, byId, {}, []);
}

describe('ToggleFramelessCommand', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    boardStore.clearBoard();
  });

  it('execute sets frameless on every target tile (round-trips through the placement cache)', () => {
    activate([makeImageTile('a', false), makeImageTile('b', false)]);
    const cmd = new ToggleFramelessCommand(['a', 'b'], true);
    cmd.execute();
    expect(boardStore.getTile('a')?.frameless).toBe(true);
    expect(boardStore.getTile('b')?.frameless).toBe(true);
  });

  it('undo restores per-tile prior state (mixed selection)', () => {
    activate([makeImageTile('a', false), makeImageTile('b', true)]);
    const cmd = new ToggleFramelessCommand(['a', 'b'], true);
    cmd.execute();
    expect(boardStore.getTile('a')?.frameless).toBe(true);
    expect(boardStore.getTile('b')?.frameless).toBe(true);
    cmd.undo();
    expect(boardStore.getTile('a')?.frameless).toBe(false);
    expect(boardStore.getTile('b')?.frameless).toBe(true);
  });

  it('description defaults to the count + direction', () => {
    activate([makeImageTile('a', false)]);
    expect(new ToggleFramelessCommand(['a'], true).description).toBe('Hide frame on 1 tile');
    expect(new ToggleFramelessCommand(['a'], false).description).toBe('Show frame on 1 tile');
  });

  it('filters out tiles that no longer exist on execute and undo', () => {
    activate([makeImageTile('a', false)]);
    const cmd = new ToggleFramelessCommand(['a', 'gone'], true);
    cmd.execute();
    expect(boardStore.getTile('a')?.frameless).toBe(true);
    cmd.undo();
    expect(boardStore.getTile('a')?.frameless).toBe(false);
  });
});
