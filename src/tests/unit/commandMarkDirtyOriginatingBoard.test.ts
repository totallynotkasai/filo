import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import {
  UpdatePropertiesCommand,
  UpdateCardFieldCommand,
} from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, KanbanBoard } from '@renderer/schema/index';
import { cancelAllPendingWrites } from '@renderer/lib/boards/boardSaver';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 6.1.R3 — a command's execute / undo must dirty the ORIGINATING
 * board, never whichever board is active at dispatch time. The bug
 * class: `boardCacheStore.markDirty(boardStore.current?.id ?? '')` lands
 * on the user's currently-focused board after a cross-board undo/redo
 * (or an async applySnapshot step that awaits a flush mid-way), missing
 * the real target.
 *
 * The fix routes every command's markDirty through `this.targetBoardId`
 * (captured at construction). This test pins the invariant via the IPC
 * spy: dispatch a command against board A while board B is the active
 * runtime board, advance the debounce window, then assert exactly one
 * `board:save` lands and its target path is A's `.board.json`.
 *
 * Two commands exercised: a Properties snapshot (UpdateProperties) and a
 * note field edit (UpdateCardField, execute and undo).
 */

function makeMindMap(id: string): BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: id,
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

function makeKanban(id: string): BoardFileData {
  return {
    board: {
      id,
      type: 'kanban',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [{ id: 'c1', title: 'Col 1', collapsed: false }],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

interface BoardSaveCapture {
  paths: string[];
}

function installFiloWithBoardSaveSpy(capture: BoardSaveCapture): void {
  installFiloMock((channel: string, ...args: unknown[]) => {
    if (channel === 'board:save') {
      capture.paths.push(args[1] as string);
      return { success: true };
    }
    if (channel === 'vault:stat') return { ok: true, mtimeMs: 1, size: 1 };
    if (channel === 'vault:read-file-text') {
      return { success: true, content: '---\ntitle: A\n---\nbody\n', mtimeMs: 1, size: 100 };
    }
    return { ok: true, success: true };
  });
}

describe('Phase 6.1.R3 — commands dirty their originating board, not the active one', () => {
  let capture: BoardSaveCapture;

  beforeEach(() => {
    vi.useFakeTimers();
    capture = { paths: [] };
    __resetDirtyTrackingForTests();
    cancelAllPendingWrites();
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
    installFiloWithBoardSaveSpy(capture);
  });

  afterEach(() => {
    cancelAllPendingWrites();
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    vi.useRealTimers();
    restoreFiloDefault();
  });

  it('UpdatePropertiesCommand (metadata kind) — saves A even when B is active', async () => {
    const a = makeMindMap('board-A');
    const b = makeMindMap('board-B');
    boardCacheStore.hydrate({ 'board-A': a, 'board-B': b }, {
      'board-A': 'A.board.json',
      'board-B': 'B.board.json',
    });

    // Construct against A explicitly.
    const cmd = new UpdatePropertiesCommand(
      { kind: 'metadata', tileId: 't1', metadata: { a: 1 } },
      { kind: 'metadata', tileId: 't1', metadata: { a: 2 } },
      'board-A',
    );

    // Pivot the active runtime board to B (the bug class's prerequisite).
    boardStore.setBoard(b.board, {}, {}, []);

    await cmd.execute();
    // Drain the board-write debounce. board:save targets A, never B.
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture.paths).toEqual(['A.board.json']);
  });

  it('UpdateCardFieldCommand — execute and undo save A even when B is active', async () => {
    const a = makeKanban('board-A');
    const b = makeKanban('board-B');
    boardCacheStore.hydrate({ 'board-A': a, 'board-B': b }, {
      'board-A': 'A.board.json',
      'board-B': 'B.board.json',
    });

    const cmd = new UpdateCardFieldCommand(
      'board-A',
      'A.md',
      { tags: ['next'] },
      { tags: ['prev'] },
    );

    boardStore.setBoard(b.board, {}, {}, []);

    await cmd.execute();
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture.paths).toContain('A.board.json');
    expect(capture.paths).not.toContain('B.board.json');

    capture.paths = [];
    await cmd.undo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture.paths).toContain('A.board.json');
    expect(capture.paths).not.toContain('B.board.json');
  });
});
