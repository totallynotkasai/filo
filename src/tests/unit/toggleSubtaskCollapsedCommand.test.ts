import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { ToggleSubtaskCollapsedCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard } from '@renderer/schema/index';

/**
 * ToggleSubtaskCollapsedCommand — Phase 3 prerequisite for the
 * "indent into collapsed parent auto-expands" BatchCommand path.
 *
 * Snapshot-based: undo restores the exact prior set regardless of any
 * intermediate toggles the user might have made (the redo path is symmetric).
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler> = {}): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function makeTaskListFixture(): V7BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'priority' },
      tasks: [],
    } as unknown as TaskListBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function getCollapsed(): string[] {
  const tl = boardCacheStore.cache.tl.board as TaskListBoard & {
    collapsedSubtasks?: string[];
  };
  return tl.collapsedSubtasks ?? [];
}

describe('ToggleSubtaskCollapsedCommand', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeTaskListFixture() },
      { tl: 'tasks.board.json' },
    );
  });
  afterEach(() => boardCacheStore.clear());

  it('execute writes the after-snapshot to the board cache', () => {
    const cmd = new ToggleSubtaskCollapsedCommand('tl', [], ['a', 'b']);
    cmd.execute();
    expect(getCollapsed().sort()).toEqual(['a', 'b']);
  });

  it('undo restores the before-snapshot exactly', () => {
    boardCacheStore.setTaskListCollapsedSubtasks('tl', ['x']);
    const cmd = new ToggleSubtaskCollapsedCommand('tl', ['x'], ['x', 'y']);
    cmd.execute();
    expect(getCollapsed().sort()).toEqual(['x', 'y']);
    cmd.undo();
    expect(getCollapsed()).toEqual(['x']);
  });

  it('round-trip preserves state across execute/undo/execute', () => {
    const cmd = new ToggleSubtaskCollapsedCommand('tl', ['p'], []);
    boardCacheStore.setTaskListCollapsedSubtasks('tl', ['p']);
    cmd.execute();
    expect(getCollapsed()).toEqual([]);
    cmd.undo();
    expect(getCollapsed()).toEqual(['p']);
    cmd.execute();
    expect(getCollapsed()).toEqual([]);
  });

  it('uses provided description, falls back to default otherwise', () => {
    const custom = new ToggleSubtaskCollapsedCommand('tl', [], ['x'], 'Expand parent');
    expect(custom.description).toBe('Expand parent');
    const fallback = new ToggleSubtaskCollapsedCommand('tl', [], ['x']);
    expect(fallback.description).toBe('Toggle subtask collapse');
  });

  it('snapshots arrays so later caller mutation does not leak into the command', () => {
    const before: string[] = ['a'];
    const after: string[] = ['a', 'b'];
    const cmd = new ToggleSubtaskCollapsedCommand('tl', before, after);
    // Mutate after construction — the command must own its own copies.
    before.push('z');
    after.push('z');
    cmd.execute();
    expect(getCollapsed().sort()).toEqual(['a', 'b']);
    cmd.undo();
    expect(getCollapsed()).toEqual(['a']);
  });
});
