/**
 * Characterisation — Kanban and Task List keep their place through a sidebar
 * delete and undo, and the global shortcuts do each board's own action.
 *
 * A card or task whose note is deleted from the sidebar comes back on undo in
 * its column or section, at its old position. Ctrl+N, Ctrl+A and Delete act
 * on the board that is showing, and no key chord is claimed by two commands
 * at once.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, reopenVault } from './harness/app';
import {
  createBoard,
  showBoard,
  placeNoteOnBoard,
  deleteInSidebar,
  undo,
  kanbanCards,
  kanbanColumns,
  taskRows,
  mindMapTiles,
  openNoteFromSidebar,
  chooseToastAction,
  toastActions,
  pressShortcut,
  clashingShortcuts,
  newCardPickerShown,
  addKanbanColumn,
  renameActiveTab,
  activeTabMenuLabels,
  activeTabName,
  boardFilesText,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const note = (title: string): string => `---\ntitle: ${title}\n---\n${title} body\n`;

describe('sidebar delete, then undo, on list boards', () => {
  it('a Kanban card comes back in its column, between the same neighbours', async () => {
    const app = await startApp({ 'A.md': note('A'), 'B.md': note('B'), 'C.md': note('C') });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    for (const rel of ['A.md', 'B.md', 'C.md']) await placeNoteOnBoard(app, 'kanban', rel);
    await waitFor(() => kanbanCards(app).length === 3, 'three cards');
    const before = kanbanColumns(app);
    expect(before[0]).toEqual(['A', 'B', 'C']);

    await deleteInSidebar(app, 'B.md');
    await waitFor(() => kanbanCards(app).length === 2, 'the card gone');

    await undo(app);
    await waitFor(() => app.exists('B.md') && kanbanCards(app).length === 3, 'the card back');
    expect(kanbanColumns(app)).toEqual(before);
    await quiesce(600);
    expect(app.read('B.md')).toBe(note('B'));
  });

  it('a Task List task comes back at its old position', async () => {
    const app = await startApp({ 'One.md': note('One'), 'Two.md': note('Two'), 'Three.md': note('Three') });
    await createBoard(app, 'tasklist');
    for (const rel of ['One.md', 'Two.md', 'Three.md']) await placeNoteOnBoard(app, 'tasklist', rel);
    await waitFor(() => taskRows(app).length === 3, 'three tasks');
    const before = taskRows(app).map((r) => r.title);

    await deleteInSidebar(app, 'Two.md');
    await waitFor(() => taskRows(app).length === 2, 'the task gone');

    await undo(app);
    await waitFor(() => app.exists('Two.md') && taskRows(app).length === 3, 'the task back');
    expect(taskRows(app).map((r) => r.title)).toEqual(before);
  });

  it('with a Document tab active, the toast offers the undo and it brings the tile back', async () => {
    const app = await startApp({ 'Plan.md': note('Plan'), 'Other.md': note('Other') });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Plan.md');
    await waitFor(() => mindMapTiles(app).length === 1, 'the tile');
    await openNoteFromSidebar(app, 'Other.md');

    await deleteInSidebar(app, 'Plan.md');
    expect(app.exists('Plan.md')).toBe(false);
    expect(toastActions()).toContain('Undo');

    await chooseToastAction('Undo');
    await waitFor(() => app.exists('Plan.md'), 'the note back');
    await showBoard(app, 'mindmap');
    await waitFor(() => mindMapTiles(app).length === 1, 'the tile back');
  });
});

describe('renaming a board from its tab', () => {
  it('the new name is saved: it survives a vault reopen', async () => {
    const app = await startApp({});
    await createBoard(app, 'kanban');
    await renameActiveTab(app, 'Sprint board');
    expect(activeTabName(app)).toBe('Sprint board');

    await reopenVault(app);
    await showBoard(app, 'kanban');
    expect(activeTabName(app)).toBe('Sprint board');
    expect(boardFilesText(app).some((t) => t.includes('"name": "Sprint board"'))).toBe(true);
  });

  it('a Document tab offers Rename Note Title, and no board emoji', async () => {
    const app = await startApp({ 'Plan.md': note('Plan') });
    await openNoteFromSidebar(app, 'Plan.md');
    const labels = await activeTabMenuLabels(app);
    expect(labels).toContain('Rename Note Title');
    expect(labels).not.toContain('Rename Board');
    expect(labels).not.toContain('Set Board Emoji');
  });
});

describe('global shortcuts follow the board type', () => {
  it('no key chord has two enabled commands on any board type', async () => {
    const app = await startApp({});
    for (const kind of ['mindmap', 'kanban', 'tasklist'] as const) {
      await createBoard(app, kind);
      expect(await clashingShortcuts(), kind).toEqual([]);
    }
    await showBoard(app, 'mindmap');
    expect(await clashingShortcuts(), 'mindmap again').toEqual([]);
  });

  it('Ctrl+N adds a tile on the Mind Map, opens the card picker on Kanban, and adds a task on Task List', async () => {
    const app = await startApp({});
    await createBoard(app, 'mindmap');
    pressShortcut('n', { ctrlKey: true });
    await waitFor(() => mindMapTiles(app).length === 1, 'a new tile');

    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const notesBefore = app.userFiles().filter((f) => f.endsWith('.md'));
    pressShortcut('n', { ctrlKey: true });
    await waitFor(() => newCardPickerShown(app), 'the new-card picker');
    await quiesce(500);
    // Nothing on disk until a card type is picked: no stray, unplaced note.
    expect(app.userFiles().filter((f) => f.endsWith('.md'))).toEqual(notesBefore);

    await createBoard(app, 'tasklist');
    pressShortcut('n', { ctrlKey: true });
    await waitFor(() => taskRows(app).length === 1, 'a new task');
  });
});
