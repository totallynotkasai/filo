import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { framesStore } from '@renderer/stores/frames.svelte';
import { MoveTilesCommand, UpdateFrameCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Frame, Tile } from '@renderer/schema/index';

/**
 * Audit 4.4 (REPRODUCE-FIRST) — claim: `MoveTilesCommand` / `UpdateFrameCommand`
 * redo re-derive frame membership GEOMETRICALLY while undo restores a snapshot,
 * so "if the user manually adjusted frame membership between the action and a
 * redo, redo can re-add a manually-excluded tile … redo isn't a faithful
 * replay." Rated LOW.
 *
 * These tests run the plan's exact sequence (action → manual membership tweak →
 * undo → redo) and assert redo reproduces the ORIGINAL action's membership.
 *
 * If they pass against unmodified code the lead is refuted: frame membership is
 * purely geometric — `framesStore.updateContainment` / `syncTileMembership`
 * derive it from tile-centre-vs-frame-bounds (frames.svelte.ts), and EVERY drag
 * re-syncs — so there is no persistent "manual membership override" that
 * disagrees with geometry to lose. A manual `updateFrame({tileIds})` done after
 * the action is an out-of-band mutation, not a tracked command: undo discards
 * it (restoring the pre-action snapshot) and redo correctly re-derives the
 * original geometric membership. (A manual change that WAS a command would push
 * onto the undo stack and clear the redo stack, so the move couldn't be redone
 * while it was in effect.)
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMapFixture(): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function activate(): void {
  const fixture = makeMindMapFixture();
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  boardStore.setBoard(fixture.board);
}

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    id: 'f1',
    boardId: 'mm',
    title: 'Frame',
    position: { x: 0, y: 0 },
    size: { width: 500, height: 500 },
    style: { backgroundImage: '', borderColor: '#000' },
    collapsed: false,
    tileIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Frame;
}

function makeTile(id: string, x: number, y: number): Tile {
  return {
    id,
    boardId: 'mm',
    type: 'text',
    title: id,
    position: { x, y },
    size: { width: 100, height: 100 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    locked: false,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    filePath: `${id}.md`,
  } as unknown as Tile;
}

describe('frame membership redo fidelity (audit 4.4)', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('MoveTilesCommand redo reproduces the original membership after a manual tweak + undo', () => {
    activate();
    boardStore.addFrame(makeFrame()); // f1 (0,0)-500x500, tileIds=[]
    boardStore.addTile(makeTile('t1', 800, 800)); // outside the frame

    // The action: drag t1 into the frame (the tileDrag flow updates the
    // position, constructs the command, then runs syncTileMembership).
    boardStore.updateTile('t1', { position: { x: 100, y: 100 } });
    const cmd = new MoveTilesCommand(
      new Map([['t1', { before: { x: 800, y: 800 }, after: { x: 100, y: 100 } }]]),
    );
    framesStore.syncTileMembership('t1');
    // Original action result: t1 is a member of the frame.
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);

    // Manual membership tweak AFTER the action — exclude t1 even though it is
    // geometrically inside. This is a direct mutation, NOT a command, so it
    // never reaches the undo/redo stack.
    boardStore.updateFrame('f1', { tileIds: [] });
    expect(boardStore.frames[0].tileIds).toEqual([]);

    cmd.undo();
    expect(boardStore.getTile('t1')!.position).toEqual({ x: 800, y: 800 });

    cmd.execute(); // redo
    expect(boardStore.getTile('t1')!.position).toEqual({ x: 100, y: 100 });
    // Crux: redo's membership matches the ORIGINAL action (t1 ∈ frame), not
    // the post-action manual exclusion that undo already discarded.
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);
  });

  it('UpdateFrameCommand resize redo reproduces the original membership after a manual tweak + undo', () => {
    activate();
    boardStore.addFrame(makeFrame({ size: { width: 200, height: 200 } })); // small frame
    boardStore.addTile(makeTile('t1', 300, 300)); // centre (350,350): outside 200x200

    // The action: grow the frame so it now contains t1 (Frame.svelte applies
    // the size, pushes the command, then runs updateContainment).
    boardStore.updateFrame('f1', { size: { width: 500, height: 500 } });
    const cmd = new UpdateFrameCommand(
      'f1',
      { size: { width: 200, height: 200 } },
      { size: { width: 500, height: 500 } },
    );
    framesStore.updateContainment('f1');
    // Original action result: the grown frame now contains t1.
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);

    // Manual membership tweak AFTER the action.
    boardStore.updateFrame('f1', { tileIds: [] });
    expect(boardStore.frames[0].tileIds).toEqual([]);

    cmd.undo();
    expect(boardStore.frames[0].size).toEqual({ width: 200, height: 200 });

    cmd.execute(); // redo
    expect(boardStore.frames[0].size).toEqual({ width: 500, height: 500 });
    // Redo re-derives geometrically and matches the original action.
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);
  });
});
