/**
 * Characterisation — the Kanban and Task List keyboard follows the screen.
 *
 * Kanban: the arrows and Shift-click ranges reach only the cards drawn (a
 * collapsed column's aren't); the arrows move keyboard focus to the card, so
 * the menu key opens its menu and moves it to another column; a card added
 * while a filter would hide it stays on screen until it is named.
 *
 * Task List: Alt+Up / Alt+Down move a task one place on screen, whatever the
 * sort; Tab makes a task a subtask of the row above at its level, and a Tab
 * that can't indent moves focus on; Escape, when nothing on the board used
 * it, still closes the Search panel; N acts only with focus in the board.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, settle, waitFor, quiesce } from './harness/app';
import {
  $,
  addKanbanCard,
  addKanbanColumn,
  createBoard,
  key,
  openTitleEditor,
  quickAddTask,
  sidebarRow,
  splitActiveTabRight,
  taskRows,
  chooseMenuItem,
  addSubtask,
  toastTexts,
} from './harness/actions';
import { focusPane, openSearchPanel, pressEscape, searchPanelOpen } from './harness/interfaceChrome';
import {
  cardByTitle,
  clickCard,
  collapseKanbanColumn,
  columnCardTitles,
  drawnCardTitles,
  drawnTasks,
  findOnKanban,
  focusKanbanBoard,
  focusedCardTitle,
  focusedTaskTitle,
  pressMenuKey,
  pressOnTask,
  selectedCardCount,
  selectedCardTitles,
  startKanbanCard,
  tabbableCards,
  taskItem,
  tocState,
  toggleToc,
} from './harness/listKeys';

afterEach(async () => {
  await stopApp();
});

describe('Kanban keys', () => {
  it('a collapsed column\'s cards are left out of a Shift-click range and skipped by the arrow keys', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanColumn(app);
    await addKanbanColumn(app);
    await addKanbanCard(app, 0, { title: 'Alpha' });
    await addKanbanCard(app, 1, { title: 'Hidden one' });
    await addKanbanCard(app, 1, { title: 'Hidden two' });
    await addKanbanCard(app, 2, { title: 'Gamma' });
    await collapseKanbanColumn(app, 1);
    expect(drawnCardTitles(app)).toEqual(['Alpha', 'Gamma']);

    await clickCard(app, 'Alpha');
    await clickCard(app, 'Gamma', { shift: true });
    expect(selectedCardTitles(app)).toEqual(['Alpha', 'Gamma']);
    expect(await selectedCardCount(app, 'Gamma')).toContain('2 cards selected');

    await clickCard(app, 'Alpha');
    key(cardByTitle(app, 'Alpha'), 'ArrowRight');
    await settle();
    expect(selectedCardTitles(app)).toEqual(['Gamma']);
  });

  it('the arrows move focus to the card, and the menu key opens its menu: Move to column moves it', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanColumn(app);
    await addKanbanCard(app, 0, { title: 'Alpha' });
    await addKanbanCard(app, 0, { title: 'Bravo' });

    key(await focusKanbanBoard(app), 'ArrowDown');
    await settle();
    expect(focusedCardTitle()).toBe('Alpha');
    key(document.activeElement as HTMLElement, 'ArrowDown');
    await settle();
    expect(focusedCardTitle()).toBe('Bravo');
    // Only the card the keys are on is a Tab stop.
    expect(tabbableCards(app)).toEqual(['Bravo']);

    const items = await pressMenuKey();
    expect(document.querySelector('.context-menu')?.textContent ?? '').toContain('Move to column');
    expect(items).toContain('New Column');
    await chooseMenuItem(app, 'New Column');
    await quiesce(600);
    expect(columnCardTitles(app, 0)).toEqual(['Alpha']);
    expect(columnCardTitles(app, 1)).toEqual(['Bravo']);
  });

  it('a card added while the find bar hides it stays on screen, its title open; named to something the bar hides, it says so', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanCard(app, 0, { title: 'Alpha' });
    await findOnKanban(app, 'Alpha');
    expect(drawnCardTitles(app)).toEqual(['Alpha']);

    const before = app.userFiles();

    await startKanbanCard(app, 0);
    await waitFor(() => openTitleEditor(app) !== null, 'the new card\'s title open for typing');
    expect(drawnCardTitles(app)).toHaveLength(2);

    const ed = openTitleEditor(app)!;
    ed.commands.insertContent('Zulu');
    key(ed.view.dom, 'Enter');
    await waitFor(() => openTitleEditor(app) === null, 'the title edit to end');
    await quiesce(800);
    expect(drawnCardTitles(app)).toEqual(['Alpha']);
    expect(toastTexts().some((t) => /"Zulu" was added to "New Column", but the filters hide it/.test(t))).toBe(true);
    // One note made, named by its title.
    expect(app.userFiles().filter((f) => !before.includes(f))).toHaveLength(1);
    // Focus went back to the board, so its keys go on working.
    expect(document.activeElement).toBe($(app.el, '.kanban-board'));
  });

  it('a card added while the find bar hides it and named to match stays, with no notice', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanCard(app, 0, { title: 'Alpha' });
    await findOnKanban(app, 'Alpha');

    await startKanbanCard(app, 0);
    await waitFor(() => openTitleEditor(app) !== null, 'the new card\'s title open for typing');
    const ed = openTitleEditor(app)!;
    ed.commands.insertContent('Alpha two');
    key(ed.view.dom, 'Enter');
    await waitFor(() => openTitleEditor(app) === null, 'the title edit to end');
    await quiesce(800);
    expect(drawnCardTitles(app)).toEqual(['Alpha', 'Alpha two']);
    expect(toastTexts().some((t) => /filters hide/.test(t))).toBe(false);
  });
});

describe('Task List keys', () => {
  it('Escape closes the Search panel with focus on a task row, as on a Kanban board', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Alpha');
    await openSearchPanel();
    taskItem(app, 'Alpha').focus();
    await settle();
    await pressEscape(taskItem(app, 'Alpha'));
    expect(searchPanelOpen()).toBe(false);

    await createBoard(app, 'kanban');
    await openSearchPanel();
    const board = await focusKanbanBoard(app);
    await pressEscape(board);
    expect(searchPanelOpen()).toBe(false);
  });

  it('in a split view, a Task List in the other pane leaves Escape to the Search panel', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await splitActiveTabRight(app);
    await focusPane(app, 1);
    await createBoard(app, 'kanban');
    expect(app.el.querySelector('.tasklist-board')).not.toBeNull();
    await openSearchPanel();
    const board = await focusKanbanBoard(app);
    await pressEscape(board);
    expect(searchPanelOpen()).toBe(false);
  });

  it('N on a sidebar row leaves the Task List alone; on the board it goes to quick add', async () => {
    const app = await startApp({ 'Chapter 1.md': '---\ntitle: Chapter 1\n---\nText\n' });
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Alpha');
    const row = sidebarRow(app, 'Chapter 1.md');
    row.focus();
    key(row, 'n');
    await settle();
    expect(document.activeElement).toBe(row);

    taskItem(app, 'Alpha').focus();
    key(taskItem(app, 'Alpha'), 'n');
    await settle();
    expect(document.activeElement).toBe($(app.el, 'input.quick-add-input'));
  });

  it('Alt+Up under the priority sort moves the task one place on screen, and switches to Manual with Undo', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Alpha !low');
    await quickAddTask(app, 'Bravo !high');
    await quickAddTask(app, 'Charlie !medium');
    await waitFor(() => drawnTasks(app).join() === 'Bravo,Charlie,Alpha', 'the tasks by priority');


    expect(await pressOnTask(app, 'Charlie', 'ArrowUp', { altKey: true })).toBe(true);
    await waitFor(() => drawnTasks(app).join() === 'Charlie,Bravo,Alpha', 'Charlie one place up');
    expect(toastTexts().some((t) => /Switched to Manual sort/.test(t))).toBe(true);
    await waitFor(() => focusedTaskTitle() === 'Charlie', 'focus kept on the moved task');

    expect(await pressOnTask(app, 'Charlie', 'ArrowDown', { altKey: true })).toBe(true);
    await waitFor(() => drawnTasks(app).join() === 'Bravo,Charlie,Alpha', 'Charlie back down');
  });

  it('Alt+Up moves a task past one with subtasks in one press; at the top it leaves the key alone', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Alpha');
    await quickAddTask(app, 'Bravo');
    await quickAddTask(app, 'Charlie');
    await addSubtask(app, taskRows(app).find((r) => r.title === 'Bravo')!.el);
    await waitFor(() => drawnTasks(app).join() === 'Alpha,Bravo,  Bravo - Subtask 1,Charlie', 'Bravo\'s subtask');

    await pressOnTask(app, 'Charlie', 'ArrowUp', { altKey: true });
    await waitFor(() => drawnTasks(app).join() === 'Alpha,Charlie,Bravo,  Bravo - Subtask 1', 'Charlie above Bravo and its subtask');
    await pressOnTask(app, 'Bravo', 'ArrowUp', { altKey: true });
    await waitFor(() => drawnTasks(app).join() === 'Alpha,Bravo,  Bravo - Subtask 1,Charlie', 'Bravo moved with its subtask');

    expect(await pressOnTask(app, 'Alpha', 'ArrowUp', { altKey: true })).toBe(false);
    expect(drawnTasks(app).join()).toBe('Alpha,Bravo,  Bravo - Subtask 1,Charlie');
  });

  it('Tab makes a task a subtask of the row above at its level; a Tab that can\'t indent moves focus on', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Alpha');
    await quickAddTask(app, 'Bravo');
    await addSubtask(app, taskRows(app).find((r) => r.title === 'Alpha')!.el);
    await waitFor(() => drawnTasks(app).join() === 'Alpha,  Alpha - Subtask 1,Bravo', 'Alpha\'s subtask');

    // One level in, under Alpha (the row at its level), not two under the subtask.
    expect(await pressOnTask(app, 'Bravo', 'Tab')).toBe(true);
    await waitFor(() => drawnTasks(app).join() === 'Alpha,  Alpha - Subtask 1,  Bravo', 'Bravo under Alpha');

    // The first task has no row above it: Tab is left to move focus on.
    expect(await pressOnTask(app, 'Alpha', 'Tab')).toBe(false);
    // Neither has the first subtask under its parent.
    expect(await pressOnTask(app, 'Alpha - Subtask 1', 'Tab')).toBe(false);
  });
});

describe('the Table of Contents', () => {
  it('folds to its header on its button and opens again, remembered on the board', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Alpha');
    expect(tocState(app)).toBe('open');
    await toggleToc(app);
    expect(tocState(app)).toBe('folded');
    const boardFile = app.userFiles().find((f) => f.endsWith('.board.json'))!;
    await waitFor(() => /"tocFolded": true/.test(app.read(boardFile)), 'the fold saved on the board');
    await toggleToc(app);
    expect(tocState(app)).toBe('open');
    await waitFor(() => /"tocFolded": false/.test(app.read(boardFile)), 'the open panel saved on the board');
  });
});
