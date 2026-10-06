import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import {
  UpdateCardFieldCommand,
  UpdateKanbanColumnStyleCommand,
} from '@renderer/commands/index';
import { historyStore } from '@renderer/stores/history.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard } from '@renderer/schema/index';
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
 * Exercised with a column style step, which changes the board. A note field
 * edit (UpdateCardField) changes only the note, so it writes neither board's
 * file (KNOWN_LIMITATIONS #29).
 */

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
  // The note keeps what was last written to it, so undo finds the value the
  // command set (not an external edit).
  let note = '---\ntitle: A\n---\nbody\n';
  let mtimeMs = 1;
  installFiloMock((channel: string, ...args: unknown[]) => {
    if (channel === 'board:save') {
      capture.paths.push(args[1] as string);
      return { success: true };
    }
    if (channel === 'vault:stat') return { ok: true, mtimeMs: 1, size: 1 };
    if (channel === 'vault:read-file-text') {
      return { success: true, content: note, mtimeMs, size: new TextEncoder().encode(note).length };
    }
    if (channel === 'vault:write-existing-file-text') {
      note = args[2] as string;
      mtimeMs++;
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

  it('a column style step — execute and undo save A even when B is active', async () => {
    const a = makeKanban('board-A');
    const b = makeKanban('board-B');
    boardCacheStore.hydrate({ 'board-A': a, 'board-B': b }, {
      'board-A': 'A.board.json',
      'board-B': 'B.board.json',
    });
    const cmd = new UpdateKanbanColumnStyleCommand('board-A', 'c1', {}, { accent: '#ff0000' });

    boardStore.setBoard(b.board);

    cmd.execute();
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture.paths).toContain('A.board.json');
    expect(capture.paths).not.toContain('B.board.json');

    capture.paths = [];
    cmd.undo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture.paths).toContain('A.board.json');
    expect(capture.paths).not.toContain('B.board.json');
  });

  it('a card field edit, run through the history, writes neither board file', async () => {
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

    boardStore.setBoard(b.board);
    historyStore.setActiveBoard('board-A');

    await historyStore.execute(cmd);
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture.paths).toEqual([]);

    await historyStore.undo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture.paths).toEqual([]);
    historyStore.clear();
  });
});
