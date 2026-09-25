import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { UpdateBoardSettingsCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Audit2 2.4 — cross-board undo/redo of an UpdateBoardSettingsCommand must
 * mutate the command's OWN board (`this.targetBoardId`), not whatever board
 * the global `boardStore` facade currently points at.
 *
 * The history store switches to a command's originating board via
 * `boardActivator` before running undo, but that pivot is `$effect`-driven
 * (asynchronous) while `command.undo()` runs synchronously — so during the
 * mutation `boardStore.current` can still be the previously-active board. A
 * command that mutated through the global facade therefore landed its undo on
 * the WRONG board, silently and with no further undo to repair it. Commands
 * that self-target by board id (Kanban / Task) are immune; the settings
 * command was not. These tests pin the board-targeting contract directly at
 * the command layer with a real cache + real command (no counter stub).
 *
 * Differentiator: board A is the active scope (`boardStore.current === A`)
 * throughout, while every command targets board B. The pre-fix code routed
 * through `boardStore.updateSettings()` (= board A), so B never changed and A
 * was clobbered; the fix routes through `boardCacheStore.updateBoardSettings(
 * targetBoardId)`, so B changes and A is untouched regardless of which board
 * is active.
 */

function makeBoard(id: string, settings: Record<string, unknown>): BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings,
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function settingsOf(boardId: string): Record<string, unknown> {
  return (boardCacheStore.cache[boardId]?.board.settings ?? {}) as Record<string, unknown>;
}

describe('UpdateBoardSettingsCommand — board-targeted execute/undo (audit2 2.4)', () => {
  beforeEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    const a = makeBoard('boardA', { bg: 'A0' });
    const b = makeBoard('boardB', { bg: 'B0' });
    boardCacheStore.hydrate(
      { boardA: a, boardB: b },
      { boardA: 'boardA.board.json', boardB: 'boardB.board.json' },
    );
    // Board A is the active scope: the global facade points at A while every
    // command below targets B — the exact cross-board precondition for the bug.
    boardStore.setBoard(a.board, {}, {}, []);
    expect(boardStore.current?.id).toBe('boardA');
  });

  afterEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });

  it('execute() mutates the target board, not the active board', () => {
    const cmd = new UpdateBoardSettingsCommand({ bg: 'B1' }, { bg: 'B0' }, [], undefined, 'boardB');
    cmd.execute();
    expect(settingsOf('boardB')).toMatchObject({ bg: 'B1' });
    // Board A (the active facade) must be untouched.
    expect(settingsOf('boardA')).toMatchObject({ bg: 'A0' });
  });

  it('undo() reverts the target board while a DIFFERENT board is active', () => {
    const cmd = new UpdateBoardSettingsCommand({ bg: 'B1' }, { bg: 'B0' }, [], undefined, 'boardB');
    cmd.execute();
    cmd.undo();
    expect(settingsOf('boardB')).toMatchObject({ bg: 'B0' });
    expect(settingsOf('boardA')).toMatchObject({ bg: 'A0' });
  });

  it('undo() deletes added keys on the target board (deleteOnUndo), not the active one', () => {
    // patch adds a brand-new key; inverse is empty; deleteOnUndo removes it on undo.
    const cmd = new UpdateBoardSettingsCommand({ accent: 'red' }, {}, ['accent'], undefined, 'boardB');
    cmd.execute();
    expect(settingsOf('boardB')).toMatchObject({ bg: 'B0', accent: 'red' });
    cmd.undo();
    expect(settingsOf('boardB')).not.toHaveProperty('accent');
    expect(settingsOf('boardA')).toMatchObject({ bg: 'A0' });
  });

  it('surfaces a warning toast (not a silent no-op) when the target board was deleted (L10)', () => {
    const cmd = new UpdateBoardSettingsCommand({ bg: 'B1' }, { bg: 'B0' }, [], undefined, 'boardB');
    cmd.execute();
    expect(settingsOf('boardB')).toMatchObject({ bg: 'B1' });

    // Board B is closed/evicted while its command still sits on a live stack
    // (undo stacks file by the GLOBAL active board, so the command outlives its
    // own board). Clear the slate so we assert only the undo's toast.
    boardCacheStore.removeBoardFromCache('boardB');
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);

    cmd.undo();
    const toast = uiStore.toasts.find((t) => /target board was deleted/i.test(t.text));
    expect(toast, 'undo on a deleted target board must surface a toast, not no-op').toBeDefined();
    expect(toast?.type).toBe('warning');
  });
});
