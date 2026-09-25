import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { framesStore } from '@renderer/stores/frames.svelte';
import { MoveTilesCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Frame, Tile } from '@renderer/schema/index';

/**
 * Phase 6 / 6.1 — MoveTilesCommand must restore frame containment on
 * undo. The previous implementation only restored tile positions: any
 * tile dragged into or out of a frame ended up referenced by the wrong
 * frame after Ctrl+Z because `frame.tileIds` was never reverted.
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
  boardStore.setBoard(fixture.board, {}, {}, []);
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

describe('MoveTilesCommand — frame containment snapshot', () => {
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

  it('undo restores frame.tileIds when a tile was dragged OUT of a frame', () => {
    activate();
    // Frame at (0,0) 500x500. Tile t1 starts inside (centre at 150,150).
    const frame = makeFrame({ tileIds: ['t1'] });
    boardStore.addFrame(frame);
    boardStore.addTile(makeTile('t1', 100, 100));

    // Simulate the post-drag state: tile moved to (800, 800) (outside frame).
    // The tileDrag flow updates positions during the drag, then constructs
    // the command, pushes without execute, and runs syncTileMembership.
    boardStore.updateTile('t1', { position: { x: 800, y: 800 } });

    // Construct the command with BEFORE/AFTER. At this point frame.tileIds
    // still reflects the pre-move state because syncTileMembership has not
    // yet run.
    const cmd = new MoveTilesCommand(
      new Map([['t1', { before: { x: 100, y: 100 }, after: { x: 800, y: 800 } }]]),
    );

    // Replay the external syncTileMembership that tileDrag.ts runs right
    // after pushing the command. This removes t1 from the frame.
    framesStore.syncTileMembership('t1');
    expect(boardStore.frames[0].tileIds).toEqual([]);

    // Undo: positions restored, frame containment restored.
    cmd.undo();
    expect(boardStore.getTile('t1')!.position).toEqual({ x: 100, y: 100 });
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);
  });

  it('undo prunes frame.tileIds when a tile was dragged INTO a frame', () => {
    activate();
    const frame = makeFrame();
    boardStore.addFrame(frame);
    boardStore.addTile(makeTile('t1', 800, 800));

    // Simulate the drag moving t1 from outside (800,800) to inside (100,100).
    boardStore.updateTile('t1', { position: { x: 100, y: 100 } });
    const cmd = new MoveTilesCommand(
      new Map([['t1', { before: { x: 800, y: 800 }, after: { x: 100, y: 100 } }]]),
    );
    framesStore.syncTileMembership('t1');
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);

    cmd.undo();
    expect(boardStore.getTile('t1')!.position).toEqual({ x: 800, y: 800 });
    // syncTileMembership in undo removes t1 from the frame (it's no longer
    // inside the bounds), and the snapshot — which captured the pre-move
    // empty state — agrees.
    expect(boardStore.frames[0].tileIds).toEqual([]);
  });

  it('redo (execute) re-applies frame containment for drag OUT', () => {
    activate();
    const frame = makeFrame({ tileIds: ['t1'] });
    boardStore.addFrame(frame);
    boardStore.addTile(makeTile('t1', 100, 100));
    boardStore.updateTile('t1', { position: { x: 800, y: 800 } });

    const cmd = new MoveTilesCommand(
      new Map([['t1', { before: { x: 100, y: 100 }, after: { x: 800, y: 800 } }]]),
    );
    framesStore.syncTileMembership('t1');
    cmd.undo();
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);

    cmd.execute();
    expect(boardStore.getTile('t1')!.position).toEqual({ x: 800, y: 800 });
    expect(boardStore.frames[0].tileIds).toEqual([]);
  });

  it('filters out tile IDs whose tiles were deleted out-of-band before undo', () => {
    activate();
    // Frame holds t1, t2. Both get moved by the command.
    const frame = makeFrame({ tileIds: ['t1', 't2'] });
    boardStore.addFrame(frame);
    boardStore.addTile(makeTile('t1', 100, 100));
    boardStore.addTile(makeTile('t2', 200, 200));

    boardStore.updateTile('t1', { position: { x: 800, y: 800 } });
    boardStore.updateTile('t2', { position: { x: 900, y: 900 } });

    const cmd = new MoveTilesCommand(
      new Map([
        ['t1', { before: { x: 100, y: 100 }, after: { x: 800, y: 800 } }],
        ['t2', { before: { x: 200, y: 200 }, after: { x: 900, y: 900 } }],
      ]),
    );
    framesStore.syncTileMembership('t1');
    framesStore.syncTileMembership('t2');

    // Delete t2 between the move and the undo.
    boardStore.removeTile('t2');

    cmd.undo();
    // t1 restored, t2's frame ref pruned, no resurrected stale ref.
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);
  });

  it('snapshot is empty for moves that do not touch any frame', () => {
    activate();
    boardStore.addTile(makeTile('t1', 1000, 1000));
    // No frames at all — the snapshot map is empty and undo is a pure
    // position restore.
    boardStore.updateTile('t1', { position: { x: 2000, y: 2000 } });
    const cmd = new MoveTilesCommand(
      new Map([['t1', { before: { x: 1000, y: 1000 }, after: { x: 2000, y: 2000 } }]]),
    );
    cmd.undo();
    expect(boardStore.getTile('t1')!.position).toEqual({ x: 1000, y: 1000 });
  });
});
