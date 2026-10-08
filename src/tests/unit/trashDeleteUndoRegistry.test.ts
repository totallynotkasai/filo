/**
 * Settings → Trash restores an item through its delete's undo while that undo
 * is still in the history. The list of such deletes keeps only those: one
 * undone from the toast or Settings → Trash, or dropped from the history,
 * leaves it, so it can't grow for the whole session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { historyStore } from '@renderer/stores/history.svelte';
import { deleteUndoCount, registerDeleteUndo } from '@renderer/stores/trash.svelte';
import type { Command } from '@renderer/commands/Command';
import { fakeCommand } from '../helpers/fakeCommand';

/**
 * A delete's step, as `vaultDeleteOps` makes it: board-agnostic, its item in
 * the trash until undone, put on the active board's stack or held off every
 * stack, and only then offered to Settings → Trash.
 */
function deleteStep(place: 'stack' | 'offStack' | 'nowhere' = 'stack'): { command: Command; trashId: () => string | null } {
  let trashId: string | null = `t-${Math.random()}`;
  const command = fakeCommand({
    description: 'Delete "a.md"',
    execute: () => {
      trashId = `t-${Math.random()}`;
    },
    undo: () => {
      trashId = null;
    },
  });
  if (place === 'stack') historyStore.pushWithoutExecute(command);
  if (place === 'offStack') historyStore.holdOffStack(command);
  registerDeleteUndo({
    trashIds: () => (trashId ? [trashId] : []),
    alsoBack: null,
    undo: async () => trashId === null,
    inHistory: () => historyStore.holds(command),
  });
  return { command, trashId: () => trashId };
}

beforeEach(() => {
  // Clearing the history also takes the last test's deletes off the list.
  historyStore.clear();
  historyStore.setActiveBoard('board-1');
});

afterEach(() => {
  historyStore.clear();
  historyStore.setActiveBoard(null);
});

describe('historyStore.holds', () => {
  it('is true on the undo stack, on the redo stack and held off-stack; false once it has left', async () => {
    const step = fakeCommand({ description: 'step', execute: () => {}, undo: () => {} });
    expect(historyStore.holds(step)).toBe(false);
    historyStore.pushWithoutExecute(step);
    expect(historyStore.holds(step)).toBe(true);
    await historyStore.undo();
    expect(historyStore.holds(step)).toBe(true); // on the redo stack
    historyStore.clear();
    expect(historyStore.holds(step)).toBe(false);

    historyStore.holdOffStack(step);
    expect(historyStore.holds(step)).toBe(true);
    await historyStore.undoOffStack(step, 'Undo step');
    expect(historyStore.holds(step)).toBe(false);
  });
});

describe('the deletes Settings → Trash can undo', () => {
  it('a delete undone from its toast leaves the list', async () => {
    const { command, trashId } = deleteStep();
    expect(deleteUndoCount()).toBe(1);

    expect(historyStore.undoFromToast(command, 'Undo delete')).toBe(true);
    await historyStore.whenChainSettled();
    expect(trashId()).toBeNull();
    expect(deleteUndoCount()).toBe(0);
  });

  it('a delete held off every stack leaves the list once undone', async () => {
    const { command } = deleteStep('offStack');
    expect(deleteUndoCount()).toBe(1);

    await historyStore.undoOffStack(command, 'Undo delete');
    expect(deleteUndoCount()).toBe(0);
  });

  it('a delete undone with Ctrl+Z stays (a redo trashes it again), and leaves once the history drops it', async () => {
    const { command, trashId } = deleteStep();
    await historyStore.undo();
    expect(trashId()).toBeNull();
    expect(historyStore.holds(command)).toBe(true);
    expect(deleteUndoCount()).toBe(1);

    await historyStore.redo();
    expect(trashId()).not.toBeNull();
    expect(deleteUndoCount()).toBe(1);

    historyStore.clearBoard('board-1');
    expect(deleteUndoCount()).toBe(0);
  });

  it('many deletes in a session leave only those still in the history', async () => {
    const steps = Array.from({ length: 20 }, () => deleteStep());
    expect(deleteUndoCount()).toBe(20);
    for (const { command } of steps.slice(0, 15)) historyStore.undoFromToast(command, 'Undo delete');
    await historyStore.whenChainSettled();
    expect(deleteUndoCount()).toBe(5);
    deleteStep('nowhere'); // a board reload dropped it before it was offered
    expect(deleteUndoCount()).toBe(5);
  });
});
