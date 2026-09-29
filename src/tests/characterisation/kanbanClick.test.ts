/**
 * Characterisation — a plain click on a Kanban card leaves the board live.
 *
 * A press and release without movement is not a drag. Afterwards the board
 * still shows every card it holds: a card added next is on screen, and no
 * column keeps the mid-drag look.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  addKanbanCard,
  kanbanCards,
  clickKanbanCard,
  kanbanColumnCounts,
  kanbanColumnsDragActive,
  errorToasts,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

describe('Kanban: a click on a card', () => {
  it('a card added after the click is shown, and the count matches', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanCard(app);
    await addKanbanCard(app);
    expect(kanbanCards(app)).toHaveLength(2);

    await clickKanbanCard(kanbanCards(app)[0]);
    expect(kanbanColumnsDragActive(app)).toBe(0);

    await addKanbanCard(app);
    expect(kanbanColumnCounts(app)[0]).toBe(3);
    expect(kanbanCards(app)).toHaveLength(3);
    expect(kanbanColumnsDragActive(app)).toBe(0);
    expect(errorToasts()).toEqual([]);
  });
});
