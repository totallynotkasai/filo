import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  AddWaypointCommand,
  RemoveWaypointCommand,
  RenameWaypointCommand,
  MoveWaypointCommand,
  UpdateWaypointIconCommand,
  ToggleWaypointLockCommand,
} from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Phase 10.2 — Waypoint commands. Each one provides execute / undo
 * symmetry against the boardStore's waypoint slice. Move / Rename /
 * UpdateIcon use before+after snapshots; Add / Remove are inverse
 * pairs; ToggleWaypointLock is its own inverse.
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

describe('AddWaypointCommand / RemoveWaypointCommand', () => {
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

  it('Add → undo removes the waypoint', () => {
    activate();
    const cmd = new AddWaypointCommand({ id: 'wp1', name: 'Home', x: 10, y: 20 });
    cmd.execute();
    expect(boardStore.waypoints.length).toBe(1);
    expect(boardStore.waypoints[0].id).toBe('wp1');
    cmd.undo();
    expect(boardStore.waypoints.length).toBe(0);
  });

  it('Remove → undo restores the waypoint exactly', () => {
    activate();
    boardStore.addWaypoint({ id: 'wp1', name: 'Home', x: 10, y: 20, icon: '🏠', locked: true });
    const wp = boardStore.waypoints[0];
    const cmd = new RemoveWaypointCommand({ ...wp });
    cmd.execute();
    expect(boardStore.waypoints.length).toBe(0);
    cmd.undo();
    expect(boardStore.waypoints.length).toBe(1);
    expect(boardStore.waypoints[0].id).toBe('wp1');
    expect(boardStore.waypoints[0].icon).toBe('🏠');
    expect(boardStore.waypoints[0].locked).toBe(true);
  });

  it('Add description includes name', () => {
    const cmd = new AddWaypointCommand({ id: 'wp1', name: 'Inbox', x: 0, y: 0 });
    expect(cmd.description).toBe('Add waypoint "Inbox"');
  });
});

describe('RenameWaypointCommand', () => {
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

  it('renames forward and restores on undo', () => {
    activate();
    boardStore.addWaypoint({ id: 'wp1', name: 'Old', x: 0, y: 0 });
    const cmd = new RenameWaypointCommand('wp1', 'Old', 'New');
    cmd.execute();
    expect(boardStore.waypoints[0].name).toBe('New');
    cmd.undo();
    expect(boardStore.waypoints[0].name).toBe('Old');
  });
});

describe('MoveWaypointCommand', () => {
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

  it('moves to `after` then restores `before`', () => {
    activate();
    boardStore.addWaypoint({ id: 'wp1', name: 'Origin', x: 10, y: 20 });
    const cmd = new MoveWaypointCommand(
      'wp1',
      { x: 10, y: 20 },
      { x: 100, y: 200 },
    );
    cmd.execute();
    expect(boardStore.waypoints[0].x).toBe(100);
    expect(boardStore.waypoints[0].y).toBe(200);
    cmd.undo();
    expect(boardStore.waypoints[0].x).toBe(10);
    expect(boardStore.waypoints[0].y).toBe(20);
  });
});

describe('UpdateWaypointIconCommand', () => {
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

  it('sets and reverts icon', () => {
    activate();
    boardStore.addWaypoint({ id: 'wp1', name: 'A', x: 0, y: 0, icon: '📌' });
    const cmd = new UpdateWaypointIconCommand('wp1', '📌', '🏠');
    cmd.execute();
    expect(boardStore.waypoints[0].icon).toBe('🏠');
    cmd.undo();
    expect(boardStore.waypoints[0].icon).toBe('📌');
  });
});

describe('ToggleWaypointLockCommand', () => {
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

  it('flips lock state and reverts on undo (self-inverse)', () => {
    activate();
    boardStore.addWaypoint({ id: 'wp1', name: 'A', x: 0, y: 0, locked: false });
    const cmd = new ToggleWaypointLockCommand('wp1');
    cmd.execute();
    expect(boardStore.waypoints[0].locked).toBe(true);
    cmd.undo();
    expect(boardStore.waypoints[0].locked).toBe(false);
  });
});
