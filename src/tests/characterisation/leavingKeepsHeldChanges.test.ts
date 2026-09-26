/**
 * Characterisation — leaving the vault keeps what the views still hold.
 *
 * A title typed but not committed, a filter change or camera move still
 * inside its debounce, a field that saves only on blur (a task's notes), and
 * keys typed while the save before leaving is out
 * all reach disk when the user closes the vault or quits from the window,
 * straight after making them. None of them may be dropped by the teardown
 * that follows the save.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, closeVault, quitFromWindow } from './harness/app';
import {
  createBoard,
  addMindMapTextTile,
  mindMapTiles,
  openNoteFromSidebar,
  placeNoteOnBoard,
  taskRows,
  openTaskNotes,
  typeTaskNotes,
} from './harness/actions';
import { waitFor } from './harness/app';
import { onlyBoardFile, whileSaveReads } from './harness/saveState';
import {
  typeTileTitle,
  typeTileTitleAndClickAway,
  chooseSmartList,
  panMindMapNow,
  typeInDocument,
  documentEditable,
  boardJson,
  savedViewports,
  addRunningTimer,
  savedTimers,
} from './harness/leaving';

afterEach(async () => {
  await stopApp();
});

describe('leaving right after an edit', () => {
  it('a tile title typed but not committed is saved by closing the vault', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const note = await addMindMapTextTile(app);
    await typeTileTitle(mindMapTiles(app)[0].el, 'Typed title');

    const left = await closeVault(app);
    expect(left.done).toBe(true);
    expect(left.dialogs).toEqual([]);
    await quiesce(300);
    expect(app.read(note)).toContain('title: Typed title');
  });

  it('a tile title renamed then closed inside its blur window is saved', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const note = await addMindMapTextTile(app);
    await typeTileTitleAndClickAway(mindMapTiles(app)[0].el, 'Clicked away');

    const left = await closeVault(app);
    expect(left.done).toBe(true);
    expect(left.dialogs).toEqual([]);
    await quiesce(300);
    expect(app.read(note)).toContain('title: Clicked away');
  });

  it('a Task List filter changed just before closing is saved with the board', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await quiesce(600);
    const board = onlyBoardFile(app);
    await chooseSmartList(app, 'Today');

    const left = await closeVault(app);
    expect(left.done).toBe(true);
    expect(left.dialogs).toEqual([]);
    const settings = boardJson(app, board).settings as { lastView?: { smartList?: string } };
    expect(settings.lastView?.smartList).toBe('today');
  });

  it('a camera move just before quitting from the window is saved', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await quiesce(600);
    const before = JSON.stringify(savedViewports(app));
    await panMindMapNow(app);

    const quit = await quitFromWindow(app);
    expect(quit.answer).toBe('ready');
    await quiesce(300);
    expect(JSON.stringify(savedViewports(app))).not.toBe(before);
  });

  it('the editor is frozen while the save before leaving is out, and what got in is saved', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\n---\nFirst\n' });
    await openNoteFromSidebar(app, 'Plan.md');
    await typeInDocument(app, ' one');

    const leaving = closeVault(app);
    let editableDuringSave = true;
    await whileSaveReads(app, 'Plan.md', async () => {
      editableDuringSave = documentEditable(app);
      await typeInDocument(app, ' two');
    });
    expect(editableDuringSave).toBe(false);
    const left = await leaving;
    expect(left.done).toBe(true);
    // Saved by a second save, not left for the leave dialog.
    expect(left.dialogs).toEqual([]);
    await quiesce(300);
    expect(app.read('Plan.md')).toContain('First one two');
  });

  it("a running timer's progress is saved to its own board when another board replaces it", async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await addRunningTimer(app);
    await quiesce(600);
    const board = onlyBoardFile(app);
    const [started] = savedTimers(app, board);
    expect(started.isRunning).toBe(true);
    await quiesce(1200);

    await createBoard(app, 'kanban');
    await quiesce(600);
    const [saved] = savedTimers(app, board);
    expect(saved.remaining).toBeLessThan(started.remaining);
  });

  it('notes typed in a task and not yet left are saved by quitting from the window', async () => {
    const rel = 'Water plants.md';
    const app = await startApp({ [rel]: '---\ntitle: Water plants\n---\nFirst\n' });
    await createBoard(app, 'tasklist');
    await placeNoteOnBoard(app, 'tasklist', rel);
    await waitFor(() => taskRows(app).some((r) => r.title === 'Water plants'), 'the task on the board');
    const row = taskRows(app).find((r) => r.title === 'Water plants')!.el;
    await openTaskNotes(row);
    await typeTaskNotes(row, 'First\nTyped, then quit\n');

    const quit = await quitFromWindow(app);
    expect(quit.answer).toBe('ready');
    await quiesce(300);
    expect(app.read(rel)).toContain('Typed, then quit');
  });
});
