/**
 * Characterisation — notes and boards, as a user meets them:
 * - switching tabs away from a raw view whose text can't be saved asks first,
 *   as closing the tab does; text that can be saved is saved;
 * - a note-only change (a ticked task, a card's due date) leaves the board's
 *   file as it was, and so does showing a board with no saved view;
 * - the Global Defaults' frame image follows a rename of its file, a delete
 *   clears it, and the delete's undo puts it back;
 * - a board from an older Filo is named as such, with its notes safe; a board
 *   file holding no board is called broken, not old.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, recoveryCopies } from './harness/app';
import {
  openNoteFromSidebar,
  openBoardFromSidebar,
  toggleRawView,
  typeInRawView,
  rawViewShown,
  rawConflictShown,
  answerConfirm,
  confirmText,
  activeTabName,
  createBoard,
  addKanbanColumn,
  addKanbanCard,
  kanbanCards,
  setCardDueDate,
  quickAddTask,
  taskRows,
  toggleTask,
  showBoard,
  renameInSidebar,
  deleteInSidebar,
  undo,
  toastTexts,
} from './harness/actions';
import { boardFiles, boardsSavedWhile, clickTab, savedGlobalDefaults, sortKanbanBy } from './harness/notesAndBoards';

afterEach(async () => {
  await stopApp();
});

const NOTE = '---\ntitle: Plan\n---\nOriginal\n';
const MINE = '---\ntitle: Plan\n---\nTyped in the raw view\n';
const THEIRS = '---\ntitle: Plan\n---\nTheirs\n';
const OTHER = '---\ntitle: Other\n---\nSomething else\n';

describe('switching tabs away from a raw view', () => {
  it("asks when its text can't be saved: Cancel stays, Switch anyway keeps a copy", async () => {
    const app = await startApp({ 'Plan.md': NOTE, 'Other.md': OTHER });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await typeInRawView(app, MINE);
    app.writeExternally('Plan.md', THEIRS);
    await quiesce(2500);
    await waitFor(() => rawConflictShown(app), 'the raw conflict banner');

    await openNoteFromSidebar(app, 'Other.md');
    await waitFor(() => confirmText().includes('Switch anyway'), 'the switch question');
    await answerConfirm(app, { confirm: false });
    expect(activeTabName(app)).toBe('Plan');
    expect(rawViewShown(app)).toBe(true);
    expect(rawConflictShown(app)).toBe(true);
    expect([...recoveryCopies(app).values()]).not.toContain(MINE);

    await clickTab(app, 'Other');
    await waitFor(() => confirmText().includes('Switch anyway'), 'the switch question again');
    await answerConfirm(app, { confirm: true });
    expect(activeTabName(app)).toBe('Other');
    await waitFor(() => [...recoveryCopies(app).values()].includes(MINE), 'a rescue copy of the raw text');
    expect(app.read('Plan.md')).toBe(THEIRS);
  });

  it('saves text that can be saved, and asks nothing', async () => {
    const app = await startApp({ 'Plan.md': NOTE, 'Other.md': OTHER });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await typeInRawView(app, MINE);

    await openNoteFromSidebar(app, 'Other.md');
    await waitFor(() => activeTabName(app) === 'Other', 'the other tab');
    await quiesce(800);
    expect(confirmText()).toBe('');
    expect(app.read('Plan.md')).toBe(MINE);
  });
});

describe('note-only changes leave the board file alone', () => {
  it("ticking a task and setting a card's due date change only the notes", async () => {
    const app = await startApp({});
    await createBoard(app, 'tasklist');
    const task = await quickAddTask(app, 'Buy milk');
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const card = await addKanbanCard(app, 0, { title: 'Draft chapter' });
    await quiesce();
    const boards = boardFiles(app);
    const [taskNote, cardNote] = [app.read(task), app.read(card)];

    const saved = await boardsSavedWhile(app, async () => {
      await setCardDueDate(kanbanCards(app)[0].el, '2026-11-02');
      await showBoard(app, 'tasklist');
      await waitFor(() => taskRows(app).length === 1, 'the task row');
      await toggleTask(taskRows(app)[0].el);
      await quiesce();
    });

    expect(saved).toEqual([]);
    expect(boardFiles(app)).toEqual(boards);
    expect(app.read(task)).not.toBe(taskNote);
    expect(app.read(task)).toContain('completed: true');
    expect(app.read(card)).not.toBe(cardNote);
    expect(app.read(card)).toContain('2026-11-02');
  });

  it('a Kanban board and a Task List with no saved view stay byte-identical when shown; a new sort is saved', async () => {
    const at = 1790000000000;
    const def = (id: string, filePath: string): Record<string, unknown> => ({
      id, type: 'text', filePath, style: { headerColor: '', bodyColor: '' }, createdAt: at, updatedAt: at,
    });
    const head = (id: string, name: string, type: string, settings: Record<string, unknown>): Record<string, unknown> => ({
      id, name, emoji: '', createdAt: at, updatedAt: at, type,
      settings: { backgroundColor: '', defaultFolder: '', accentColor: '', ...settings, defaults: {} },
    });
    const kanban = JSON.stringify({
      version: 8,
      board: {
        ...head('handkb1', 'Hand Kanban', 'kanban', {}),
        columns: [{ id: 'colhand1', title: 'To do', position: 0, collapsed: false, tilePlacements: [{ tileId: 'kbhand1', position: 0 }] }],
      },
      tileDefs: { kbhand1: def('kbhand1', 'One.md') },
      connections: {},
      frames: [],
    }, null, 2);
    const taskList = JSON.stringify({
      version: 8,
      board: {
        ...head('handtl1', 'Hand List', 'tasklist', { groupBy: 'none', sortBy: 'manual' }),
        tasks: [{ tileId: 'tlhand1', position: 0 }],
        sections: [{ id: 'sec_hand', title: 'Section 1', position: 0, collapsed: false }],
        collapsedSubtasks: [],
      },
      tileDefs: { tlhand1: def('tlhand1', 'Two.md') },
      connections: {},
      frames: [],
    }, null, 2);
    const app = await startApp({
      'One.md': '---\ntitle: One\n---\nFirst\n',
      'Two.md': '---\ntitle: Two\n---\nSecond\n',
      'Hand Kanban.board.json': kanban,
      'Hand List.board.json': taskList,
    });
    await openBoardFromSidebar(app, 'Hand Kanban.board.json', 'kanban');
    await waitFor(() => kanbanCards(app).length === 1, 'the card');
    await openBoardFromSidebar(app, 'Hand List.board.json', 'tasklist');
    await waitFor(() => taskRows(app).length === 1, 'the task');
    await showBoard(app, 'kanban');
    await quiesce();
    expect(app.read('Hand Kanban.board.json')).toBe(kanban);
    expect(app.read('Hand List.board.json')).toBe(taskList);

    await sortKanbanBy(app, 'Title');
    await quiesce();
    expect(JSON.parse(app.read('Hand Kanban.board.json') ?? '{}').board.settings.lastView).toMatchObject({ sortBy: 'title' });
  });
});

describe("the Global Defaults' frame image", () => {
  it('follows a rename of its file; a delete clears it, and Undo puts it back', async () => {
    const app = await startApp({
      'Images/Paper.png': 'png',
      '.filo/defaults.json': JSON.stringify({ mindmap: { frame: { backgroundImage: 'Images/Paper.png' } } }, null, 2),
    });
    await createBoard(app, 'mindmap');

    await renameInSidebar(app, 'Images/Paper.png', 'Parchment.png');
    await quiesce();
    expect(savedGlobalDefaults(app).mindmap?.frame?.backgroundImage).toBe('Images/Parchment.png');

    await deleteInSidebar(app, 'Images/Parchment.png');
    await quiesce();
    expect(savedGlobalDefaults(app).mindmap?.frame?.backgroundImage).toBe('');

    await undo(app);
    await quiesce();
    expect(app.read('Images/Parchment.png')).toBe('png');
    expect(savedGlobalDefaults(app).mindmap?.frame?.backgroundImage).toBe('Images/Parchment.png');
  });
});

describe('boards Filo can\'t open', () => {
  it('a board from an older Filo says its notes are safe; a file holding no board is called broken', async () => {
    const old = JSON.stringify({
      version: 7,
      board: { id: 'b_old', type: 'mindmap', name: 'Old', emoji: '', createdAt: 1, updatedAt: 1, settings: {}, placements: {}, inlineTiles: {}, groups: [], waypoints: [] },
      tileDefs: {},
      connections: {},
      frames: [],
    }, null, 2);
    const twice = JSON.stringify(old);
    await startApp({ 'Old.board.json': old, 'Twice.board.json': twice });
    await waitFor(() => toastTexts().some((t) => t.includes('Old.board.json')), 'the older-board notice');
    await waitFor(() => toastTexts().some((t) => t.includes('Twice.board.json')), 'the broken-board notice');
    const oldNotice = toastTexts().find((t) => t.includes('Old.board.json')) ?? '';
    const twiceNotice = toastTexts().find((t) => t.includes('Twice.board.json')) ?? '';
    expect(oldNotice).toContain('made by an older Filo (board format 7)');
    expect(oldNotice).toContain('its notes are safe');
    expect(oldNotice).not.toContain('text editor');
    expect(twiceNotice).toContain('the whole file is one quoted text, not a board');
    expect(twiceNotice).not.toContain('older Filo');
  });
});
