import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  AddFrameCommand,
  AddConnectionCommand,
  MoveFrameCommand,
  DeleteFrameCommand,
  UpdateFrameCommand,
} from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Frame, Connection, Tile } from '@renderer/schema/index';

/**
 * Add*Command snapshots must be deep clones. A shallow
 * `{ ...frame }` lets later mutations of `frame.style.*` or `frame.tileIds[*]`
 * silently leak into the would-be-restored value when execute()/undo() runs
 * after the user has continued editing. The same risk applies to
 * AddConnectionCommand's nested `label`. A JSON round-trip is the standard
 * pattern for every Add/Delete *Command.
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
    title: 'My Frame',
    position: { x: 100, y: 100 },
    size: { width: 400, height: 300 },
    style: {
      backgroundImage: '',
      borderColor: '#abcdef',
    },
    collapsed: false,
    tileIds: ['t1', 't2'],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Frame;
}

describe('AddFrameCommand — deep clone snapshot', () => {
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

  it('execute → undo round-trip works', () => {
    activate();
    const frame = makeFrame();
    const cmd = new AddFrameCommand(frame);
    cmd.execute();
    expect(boardStore.frames.length).toBe(1);
    expect(boardStore.frames[0].id).toBe('f1');
    cmd.undo();
    expect(boardStore.frames.length).toBe(0);
  });

  it('caller mutation of frame.style after construction does not leak into the snapshot', () => {
    activate();
    const frame = makeFrame();
    const cmd = new AddFrameCommand(frame);
    // Mutate the caller's frame after constructing the command. With the
    // shallow `{ ...frame }` clone, this would corrupt the stored style.
    frame.style.borderColor = '#deadbeef';
    frame.tileIds.push('t3');

    cmd.execute();
    const live = boardStore.frames[0];
    expect(live.style.borderColor).toBe('#abcdef');
    expect(live.tileIds).toEqual(['t1', 't2']);
  });

  it('mutating live frame after execute does not leak into snapshot for redo', () => {
    activate();
    const frame = makeFrame();
    const cmd = new AddFrameCommand(frame);
    cmd.execute();

    // User edits the frame's style; then undoes and redoes.
    boardStore.updateFrame('f1', { style: { ...boardStore.frames[0].style, borderColor: '#000000' } });
    cmd.undo();
    expect(boardStore.frames.length).toBe(0);

    cmd.execute();
    // Redo must restore the ORIGINAL borderColor, not the user's in-between edit.
    expect(boardStore.frames[0].style.borderColor).toBe('#abcdef');
  });

  it('description includes the title', () => {
    const cmd = new AddFrameCommand(makeFrame({ title: 'Quadrant 1' }));
    expect(cmd.description).toBe('Add frame "Quadrant 1"');
  });
});

describe('AddConnectionCommand — deep clone snapshot', () => {
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

  it('caller mutation of connection.label after construction does not leak in', () => {
    activate();
    const conn: Connection = {
      id: 'c1',
      boardId: 'mm',
      fromTileId: 't_a',
      toTileId: 't_b',
      fromBubble: 3,
      toBubble: 7,
      pathColor: '#aaa',
      arrowColor: '#aaa',
      label: { text: 'original-label', textColor: '#000', backgroundColor: '', position: 0.5, locked: false },
      visibility: 'visible',
      labelVisibility: 'visible',
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Connection;

    const cmd = new AddConnectionCommand(conn);
    // Mutate the caller's nested label after constructing. With shallow clone,
    // this would corrupt the snapshot's label.text.
    (conn.label as { text: string }).text = 'mutated';

    cmd.execute();
    const stored = boardStore.connections['c1'];
    expect(stored).toBeDefined();
    expect(stored.label.text).toBe('original-label');
  });

  // A genuine execute → undo → redo round-trip. The file used to
  // only construct + execute AddConnectionCommand (the deep-clone test
  // above), so the file-level roundtrip-coverage gate passed it for free via
  // sibling commands' `.undo(` calls; the tightened window-scoped gate exposed
  // that there was no real round-trip. AddConnectionCommand is a deterministic
  // add (execute adds, undo removes by id) — this pins both directions.
  it('execute adds the connection, undo removes it, redo re-adds', () => {
    activate();
    const conn: Connection = {
      id: 'c-rt',
      boardId: 'mm',
      fromTileId: 't_a',
      toTileId: 't_b',
      fromBubble: 1,
      toBubble: 2,
      pathColor: '#aaa',
      arrowColor: '#aaa',
      label: { text: 'L', textColor: '#000', backgroundColor: '', position: 0.5, locked: false },
      visibility: 'visible',
      labelVisibility: 'visible',
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Connection;

    const cmd = new AddConnectionCommand(conn);
    cmd.execute();
    expect(boardStore.connections['c-rt']).toBeDefined();
    cmd.undo();
    expect(boardStore.connections['c-rt']).toBeUndefined();
    cmd.execute(); // redo
    expect(boardStore.connections['c-rt']).toBeDefined();
  });
});

/**
 * MoveFrameCommand must call `framesStore.updateContainment` after
 * execute() and undo() so the frame's tileIds reflect what its restored
 * bounds actually contain. Without this, a tile added between drag and
 * a later redo would not be picked up; a tile that left the frame's
 * area before undo would still appear "inside" after undo.
 */
describe('MoveFrameCommand — updateContainment after execute/undo', () => {
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

  it('execute recomputes containment to match the restored bounds', () => {
    activate();
    // Seed a frame at (100,100) 400x300 containing only t1.
    const frame = makeFrame({ id: 'f1', position: { x: 100, y: 100 }, size: { width: 400, height: 300 }, tileIds: ['t1'] });
    boardStore.addFrame(frame);

    // Add tiles: t1 inside the frame at (200,200), t2 OUTSIDE at (700,700).
    boardStore.addTile(makeTile('t1', 200, 200));
    boardStore.addTile(makeTile('t2', 700, 700));

    // Construct a MoveFrameCommand that moves the frame to (550, 550) where it
    // would now contain t2 (centre at 750,750 lies inside [550,950]) and lose t1.
    const cmd = new MoveFrameCommand(
      'f1',
      { x: 100, y: 100 },
      { x: 550, y: 550 },
      ['t1'],
    );
    cmd.execute();

    // After execute, applyTo moves t1 by the delta (now at 650,650), so t1's
    // centre (700,700) sits inside [550,950] too. Both t1 and t2 should now be
    // contained.
    const after = boardStore.frames.find((f) => f.id === 'f1')!;
    expect(after.tileIds.sort()).toEqual(['t1', 't2']);
  });

  it('undo recomputes containment to match the original bounds', () => {
    activate();
    const frame = makeFrame({ id: 'f1', position: { x: 100, y: 100 }, size: { width: 400, height: 300 }, tileIds: ['t1'] });
    boardStore.addFrame(frame);
    boardStore.addTile(makeTile('t1', 200, 200));
    boardStore.addTile(makeTile('t2', 700, 700));

    const cmd = new MoveFrameCommand(
      'f1',
      { x: 100, y: 100 },
      { x: 550, y: 550 },
      ['t1'],
    );
    cmd.execute();
    cmd.undo();

    // After undo, frame is back at (100,100). t1 was moved with the frame
    // during execute then back during undo (start at 200,200; +450,+450 →
    // (650,650); -450,-450 → (200,200) again). Centre (250,250) lies inside
    // [100,500]. t2 at (700,700) is outside. So only t1 should be contained.
    const after = boardStore.frames.find((f) => f.id === 'f1')!;
    expect(after.tileIds).toEqual(['t1']);
  });
});

/**
 * DeleteFrameCommand must throw an explicit Error when the target
 * frame is missing. Without the guard, `JSON.stringify(undefined)` returns
 * the value `undefined`, which `JSON.parse` then throws on with an opaque
 * "Unexpected token u in JSON" — a poor diagnostic for what is actually a
 * race between a stale UI handle and a frame that has already been removed
 * (external delete, undo of an AddFrameCommand, …).
 */
/**
 * UpdateFrameCommand must snapshot frame containment
 * when `size` is in the patch. Without this, resizing a frame and then
 * undoing leaves `frame.tileIds` reflecting the post-resize containment
 * even though the frame's size is back to before.
 */
describe('UpdateFrameCommand — size patch restores containment', () => {
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

  it('undo restores frame.tileIds after a size shrink that ejected a tile', () => {
    activate();
    // Frame 500x500 at origin. Two tiles inside: t1 (50,50) and t2 (300,300).
    boardStore.addFrame(makeFrame({
      id: 'f1',
      position: { x: 0, y: 0 },
      size: { width: 500, height: 500 },
      tileIds: ['t1', 't2'],
    }));
    boardStore.addTile(makeTile('t1', 50, 50));
    boardStore.addTile(makeTile('t2', 300, 300));

    // Construct an UpdateFrameCommand that shrinks the frame to 200x200.
    // Snapshot happens in the constructor — before any updateContainment.
    const cmd = new UpdateFrameCommand(
      'f1',
      { size: { width: 500, height: 500 } },
      { size: { width: 200, height: 200 } },
    );

    // Apply the shrink (as Frame.svelte would). t2 now lies outside.
    cmd.execute();
    expect(boardStore.frames[0].size.width).toBe(200);
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);

    // Undo: size back to 500x500, containment back to [t1, t2].
    cmd.undo();
    expect(boardStore.frames[0].size.width).toBe(500);
    expect(boardStore.frames[0].tileIds.sort()).toEqual(['t1', 't2']);
  });

  it('execute (redo) re-derives containment via updateContainment', () => {
    activate();
    boardStore.addFrame(makeFrame({
      id: 'f1',
      position: { x: 0, y: 0 },
      size: { width: 500, height: 500 },
      tileIds: ['t1', 't2'],
    }));
    boardStore.addTile(makeTile('t1', 50, 50));
    boardStore.addTile(makeTile('t2', 300, 300));

    const cmd = new UpdateFrameCommand(
      'f1',
      { size: { width: 500, height: 500 } },
      { size: { width: 200, height: 200 } },
    );
    cmd.execute();
    cmd.undo();
    // Redo: tileIds should match the post-shrink state ([t1] only).
    cmd.execute();
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);
  });

  it('non-size patch (title) does not touch containment', () => {
    activate();
    boardStore.addFrame(makeFrame({
      id: 'f1',
      position: { x: 0, y: 0 },
      size: { width: 500, height: 500 },
      tileIds: ['t1'],
    }));
    boardStore.addTile(makeTile('t1', 50, 50));

    const cmd = new UpdateFrameCommand(
      'f1',
      { title: 'Before' },
      { title: 'After' },
    );
    cmd.execute();
    expect(boardStore.frames[0].title).toBe('After');
    // tileIds untouched — no updateContainment was scheduled.
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);
    cmd.undo();
    expect(boardStore.frames[0].title).toBe('Before');
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);
  });

  it('snapshot tolerates a tile deleted out-of-band before undo', () => {
    activate();
    boardStore.addFrame(makeFrame({
      id: 'f1',
      position: { x: 0, y: 0 },
      size: { width: 500, height: 500 },
      tileIds: ['t1', 't2'],
    }));
    boardStore.addTile(makeTile('t1', 50, 50));
    boardStore.addTile(makeTile('t2', 300, 300));

    const cmd = new UpdateFrameCommand(
      'f1',
      { size: { width: 500, height: 500 } },
      { size: { width: 200, height: 200 } },
    );
    cmd.execute();

    // t2 deleted between resize and undo.
    boardStore.removeTile('t2');

    cmd.undo();
    // Snapshot is [t1, t2] but the filter drops t2 (no longer in store).
    expect(boardStore.frames[0].tileIds).toEqual(['t1']);
  });
});

describe('DeleteFrameCommand — missing-frame guard', () => {
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

  it('throws a typed error when constructed against a non-existent frame id', () => {
    activate();
    expect(() => new DeleteFrameCommand('does-not-exist')).toThrow(
      /DeleteFrameCommand: frame does-not-exist not found/,
    );
  });

  it('execute / undo round-trip works for an existing frame', () => {
    activate();
    const frame = makeFrame();
    boardStore.addFrame(frame);
    const cmd = new DeleteFrameCommand(frame.id);
    cmd.execute();
    expect(boardStore.frames.length).toBe(0);
    cmd.undo();
    expect(boardStore.frames.length).toBe(1);
    expect(boardStore.frames[0].id).toBe(frame.id);
  });
});
