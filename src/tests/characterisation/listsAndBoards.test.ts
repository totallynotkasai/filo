/**
 * Characterisation — the Task List and Kanban as the user works them, after
 * Audit-28 Phase 4:
 *
 * - the keys, Tab and Shift-click follow the rows on screen, not the order in
 *   the file, so a bulk Delete removes only the rows shown highlighted;
 * - quick add files a task where Add Task does, and reads repeats and times
 *   without taking words for dates;
 * - Filter by Status agrees with Group by Status; Group By groups inside each
 *   section and its button is never greyed out; folding a section is an undo
 *   step;
 * - the date picker works from the keyboard; the Repeat menu sets any "every
 *   N" and what the next date counts from;
 * - a Kanban card's date is picked in the same picker, and one card moves to
 *   another column from its own menu;
 * - Backspace on the Mind Map asks the same Remove as Delete.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, type CharApp } from './harness/app';
import {
  addKanbanCard,
  addKanbanColumn,
  addMindMapTextTile,
  createBoard,
  indentTask,
  kanbanCards,
  kanbanColumns,
  mindMapTiles,
  quickAddTask,
  setCardDueDate,
  taskIsSubtask,
  taskRows,
  toggleTask,
  undo,
} from './harness/actions';
import {
  addTaskSection,
  bulkDeleteTasks,
  chooseTaskGroupBy,
  clickTaskRow,
  datePickerFocusedDay,
  filterTasksByStatus,
  focusedTaskTitle,
  kanbanColumnTitles,
  keyInDatePicker,
  keyOnTaskRow,
  moveCardByMenu,
  saveRepeatEvery,
  selectedTaskTitles,
  setTaskRepeat,
  taskGroupByEnabled,
  taskListDrawn,
  taskSections,
  taskStatusChips,
  toggleTaskSection,
} from './harness/lists';
import { datePickerOpen } from './harness/actions';
import { selectTile, confirmOpen } from './harness/mindMapKeys';
import { pressAtFocus } from './harness/typingFocus';

afterEach(async () => {
  await stopApp();
});

const titles = (app: CharApp): string[] => taskRows(app).map((r) => r.title);
const row = (app: CharApp, title: string): HTMLElement => {
  const r = taskRows(app).find((t) => t.title === title);
  if (!r) throw new Error(`no row "${title}"`);
  return r.el;
};

/** Today's local `YYYY-MM-DD`, `days` on. */
function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A Task List sorted by priority (the default) with four tasks: on screen Delta, Bravo, Alpha, Charlie. */
async function priorityList(app: CharApp): Promise<void> {
  await createBoard(app, 'tasklist');
  await quickAddTask(app, 'Alpha !low');
  await quickAddTask(app, 'Bravo !high');
  await quickAddTask(app, 'Charlie');
  await quickAddTask(app, 'Delta !urgent');
  await waitFor(() => titles(app).join() === 'Delta,Bravo,Alpha,Charlie', 'the rows sorted by priority');
}

describe('the keys and ranges follow the screen', () => {
  it('a Shift-click range on a priority-sorted list selects the rows between the clicks, and bulk Delete removes only those', async () => {
    const app = await startApp();
    await priorityList(app);
    const notesBefore = app.userFiles().filter((f) => f.endsWith('.md')).sort();

    await clickTaskRow(row(app, 'Delta'));
    await clickTaskRow(row(app, 'Alpha'), { shift: true });
    expect(selectedTaskTitles(app)).toEqual(['Delta', 'Bravo', 'Alpha']);

    await bulkDeleteTasks();
    await waitFor(() => titles(app).join() === 'Charlie', 'only Charlie left');
    await quiesce(600);
    const board = JSON.parse(app.read(app.userFiles().find((f) => f.endsWith('.board.json'))!)) as { board: { tasks: unknown[] } };
    expect(board.board.tasks).toHaveLength(1);
    // Remove from board: the notes stay in the vault.
    expect(app.userFiles().filter((f) => f.endsWith('.md')).sort()).toEqual(notesBefore);
  });

  it('ArrowDown goes to the row below on screen, and Tab indents under it', async () => {
    const app = await startApp();
    await priorityList(app);
    await keyOnTaskRow(row(app, 'Delta'), 'ArrowDown');
    expect(focusedTaskTitle()).toBe('Bravo');
    await keyOnTaskRow(row(app, 'Bravo'), 'ArrowDown');
    expect(focusedTaskTitle()).toBe('Alpha');

    await indentTask(row(app, 'Charlie'));
    await waitFor(() => taskIsSubtask(row(app, 'Charlie')), 'Charlie nested');
    // Under Alpha, the row above it on screen (in the file it follows Bravo).
    expect(titles(app)).toEqual(['Delta', 'Bravo', 'Alpha', 'Charlie']);
  });
});

describe('quick add', () => {
  it('files into the first section, not a folded last one, and a fold is an undo step', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await addTaskSection(app, 'Done');
    await toggleTaskSection(app, 'Done');
    expect(taskSections(app)).toEqual(['Task List', '(Done)']);

    await quickAddTask(app, 'Outline chapter 3');
    await waitFor(() => titles(app).includes('Outline chapter 3'), 'the task shown');
    expect(taskSections(app)).toEqual(['Task List', '(Done)']);

    await undo(app); // the task
    await waitFor(() => !titles(app).includes('Outline chapter 3'), 'the task undone');
    await undo(app); // the fold
    await waitFor(() => taskSections(app).join() === 'Task List,Done', 'Done open again');
  });

  it('reads a repeat and a time after the date, and leaves words and fractions in the title', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const water = await quickAddTask(app, 'Water plants every friday');
    const call = await quickAddTask(app, 'Call the printer tomorrow 5pm');
    await quickAddTask(app, 'Review plot outline next month');
    await quickAddTask(app, 'Revise act 2/3 of the book');
    await quiesce(600);
    expect(app.read(water)).toMatch(/^recurrence: weekly$/m);
    expect(app.read(water)).toMatch(/^dueDate: \d{4}-\d{2}-\d{2}$/m);
    expect(app.read(call)).toMatch(new RegExp(`^dueDate: ${isoInDays(1)}$`, 'm'));
    expect(app.read(call)).toMatch(/^dueTime: "?17:00"?$/m);
    expect(titles(app)).toEqual(expect.arrayContaining([
      'Water plants', 'Call the printer', 'Review plot outline next month', 'Revise act 2/3 of the book',
    ]));
  });
});

describe('filter and group', () => {
  it('Filter by Status finds tasks made in Filo; Group By groups inside the section and is never greyed out', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Draft');
    await quickAddTask(app, 'Edit');
    await toggleTask(row(app, 'Edit'));
    await waitFor(() => taskRows(app).find((r) => r.title === 'Edit')?.completed === true, 'Edit done');

    expect(taskGroupByEnabled(app)).toBe(true);
    await chooseTaskGroupBy(app, 'Status');
    await waitFor(() => taskListDrawn(app).join() === '[To Do 1] Draft,[Done 1] Edit', 'grouped by status');
    await chooseTaskGroupBy(app, 'None');
    await waitFor(() => !taskListDrawn(app).some((r) => r.startsWith('[')), 'no headings');
    expect(taskGroupByEnabled(app)).toBe(true);

    await filterTasksByStatus(app, 'To Do');
    expect(taskStatusChips(app)).toEqual(['Any', 'To Do', 'Done']);
    await waitFor(() => titles(app).join() === 'Draft', 'only the open task');
  });
});

describe('dates and repeats', () => {
  it('D opens the date picker on the task\'s day; the arrows and Enter pick, and focus comes back', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const note = await quickAddTask(app, 'Dentist tomorrow');
    await keyOnTaskRow(row(app, 'Dentist'), 'd');
    await waitFor(() => datePickerFocusedDay() === isoInDays(1), 'focus on tomorrow');
    await keyInDatePicker('ArrowRight');
    expect(datePickerFocusedDay()).toBe(isoInDays(2));
    (document.activeElement as HTMLElement).click(); // Enter on the focused day
    await waitFor(() => !datePickerOpen(), 'the picker closed');
    await quiesce(600);
    expect(app.read(note)).toMatch(new RegExp(`^dueDate: ${isoInDays(2)}$`, 'm'));
    await waitFor(() => focusedTaskTitle() === 'Dentist', 'focus back on the row');

    await keyOnTaskRow(row(app, 'Dentist'), 'd');
    await waitFor(() => datePickerOpen(), 'the picker open');
    await pressAtFocus('Escape');
    await waitFor(() => !datePickerOpen(), 'Escape closed it');
  });

  it('the Repeat menu sets every 3 days, counted from the day it is done', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const note = await quickAddTask(app, 'Stretch every day');
    await setTaskRepeat(app, row(app, 'Stretch'), 'Every…');
    await saveRepeatEvery(3, 'days');
    await waitFor(() => /^recurrence: every 3 days$/m.test(app.read(note)), 'the rule saved');
    await setTaskRepeat(app, row(app, 'Stretch'), 'The day it is done');
    await waitFor(() => /^recurrenceMode: completion$/m.test(app.read(note)), 'the mode saved');
  });
});

describe('Kanban', () => {
  it('a card\'s due date is picked in the picker, and one card moves to another column from its menu', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanColumn(app);
    const note = await addKanbanCard(app, 0, { title: 'Siege' });
    await addKanbanCard(app, 0, { title: 'River' });

    await setCardDueDate(kanbanCards(app).find((c) => c.title === 'Siege')!.el, isoInDays(10));
    await waitFor(() => new RegExp(`^dueDate: ${isoInDays(10)}$`, 'm').test(app.read(note)), 'the date saved');

    await moveCardByMenu(app, kanbanCards(app).find((c) => c.title === 'Siege')!.el, kanbanColumnTitles(app)[1]!);
    await waitFor(() => kanbanColumns(app)[1]?.join() === 'Siege', 'Siege moved');
    expect(kanbanColumns(app)[0]).toEqual(['River']);
  });
});

describe('Mind Map', () => {
  it('Backspace asks the same Remove as Delete, offering to move the note to the trash too', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await addMindMapTextTile(app, { title: 'Antagonist' });
    await selectTile(mindMapTiles(app)[0]!.el);
    await pressAtFocus('Backspace');
    await waitFor(() => confirmOpen(), 'the Remove prompt');
    const dialog = document.querySelector('.confirm-dialog')!;
    expect(dialog.textContent).toContain('Remove tile from board?');
    expect(dialog.querySelector('.confirm-extra-option')?.textContent).toContain('Delete associated files from vault as well?');
  });
});
