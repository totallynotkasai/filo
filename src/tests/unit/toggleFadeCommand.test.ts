/**
 * Phase 7 / 7.7 — ToggleFadeCommand: generic "fade these tiles" undoable.
 *
 * The command snapshots each tile's prior `faded` flag so undo restores the
 * mixed state exactly even if the caller mixed already-faded and unfaded
 * tiles into the same call (the bulk fade gesture on a heterogeneous
 * selection).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { ToggleFadeCommand } from '@renderer/commands/index';
import type { Tile, MindMapBoard } from '@renderer/schema/index';
import { seedBoard } from '../helpers/seedBoard';

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeTile(id: string, faded: boolean): Tile {
  return {
    id,
    type: 'text',
    title: id,
    boardId: 'b',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    locked: false,
    faded,
    tags: [],
    filePath: `${id}.md`,
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

describe('ToggleFadeCommand', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    boardStore.clearBoard();
  });

  it('execute fades every tile to the target state', () => {
    activate([makeTile('a', false), makeTile('b', false)]);
    const cmd = new ToggleFadeCommand(['a', 'b'], true);
    cmd.execute();
    expect(boardStore.getTile('a')?.faded).toBe(true);
    expect(boardStore.getTile('b')?.faded).toBe(true);
  });

  it('undo restores per-tile prior state (mixed selection)', () => {
    activate([makeTile('a', false), makeTile('b', true)]);
    // Forward: fade both. Snapshot captures {a:false, b:true}.
    const cmd = new ToggleFadeCommand(['a', 'b'], true);
    cmd.execute();
    expect(boardStore.getTile('a')?.faded).toBe(true);
    expect(boardStore.getTile('b')?.faded).toBe(true);
    cmd.undo();
    expect(boardStore.getTile('a')?.faded).toBe(false);
    expect(boardStore.getTile('b')?.faded).toBe(true);
  });

  it('description defaults to the count + direction', () => {
    activate([makeTile('a', false)]);
    expect(new ToggleFadeCommand(['a'], true).description).toBe('Fade 1 tile(s)');
    expect(new ToggleFadeCommand(['a'], false).description).toBe('Unfade 1 tile(s)');
  });

  it('honours a custom description', () => {
    activate([makeTile('a', false)]);
    expect(new ToggleFadeCommand(['a'], true, 'Custom').description).toBe('Custom');
  });

  it('filters out tiles that no longer exist on execute and undo', () => {
    activate([makeTile('a', false)]);
    const cmd = new ToggleFadeCommand(['a', 'gone'], true);
    cmd.execute();
    expect(boardStore.getTile('a')?.faded).toBe(true);
    cmd.undo();
    expect(boardStore.getTile('a')?.faded).toBe(false);
  });
});
