/**
 * Characterisation — a Task List's subtask hierarchy is board structure.
 *
 * Indenting a task records its parent on the board (the parent is a tile of
 * that board, meaningless to any other), and leaves the note alone. A note
 * that already names a `parent:` is still shown nested; outdenting it records
 * the change on the board and doesn't rewrite the note.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, type CharApp } from './harness/app';
import {
  createBoard,
  quickAddTask,
  taskRows,
  indentTask,
  taskIsSubtask,
  addSubtask,
  undo,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

interface SavedTask {
  tileId: string;
  filePath: string;
  parentTileId?: string;
}

/** The Task List's tasks as saved, with the note each one names. */
function savedTasks(app: CharApp): SavedTask[] {
  const rel = app.userFiles().find((f) => f.endsWith('.board.json'));
  if (!rel) throw new Error('no board file');
  const file = JSON.parse(app.read(rel)) as {
    board: { tasks: Array<{ tileId: string; parentTileId?: string }> };
    tileDefs: Record<string, { filePath?: string }>;
  };
  return file.board.tasks.map((t) => ({
    tileId: t.tileId,
    filePath: file.tileDefs[t.tileId]?.filePath ?? '',
    ...(t.parentTileId !== undefined ? { parentTileId: t.parentTileId } : {}),
  }));
}

function taskFor(app: CharApp, note: string): SavedTask {
  const t = savedTasks(app).find((s) => s.filePath === note);
  if (!t) throw new Error(`no task for ${note}`);
  return t;
}

describe('subtasks', () => {
  it('Tab records the parent on the board, not in the note, and undo takes it back', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const parentNote = await quickAddTask(app, 'Plan trip');
    const childNote = await quickAddTask(app, 'Book hotel');
    await waitFor(() => taskRows(app).length === 2, 'two tasks');
    const childBefore = app.read(childNote);

    await indentTask(taskRows(app)[1]!.el);
    await waitFor(() => taskIsSubtask(taskRows(app)[1]!.el), 'the second task nested');
    await waitFor(() => taskFor(app, childNote).parentTileId === taskFor(app, parentNote).tileId, 'the parent saved on the board');
    await quiesce(600);
    expect(app.read(childNote)).toBe(childBefore);
    expect(app.read(childNote)).not.toMatch(/^parent:/m);

    await undo(app);
    await waitFor(() => !taskIsSubtask(taskRows(app)[1]!.el), 'the task back at the top level');
    await waitFor(() => taskFor(app, childNote).parentTileId === undefined, 'the board without the parent');
    expect(app.read(childNote)).toBe(childBefore);
  });

  it('Add subtask puts each new subtask below the ones already there, and undo takes back the newest', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Plan trip');
    await quickAddTask(app, 'Pack');
    await waitFor(() => taskRows(app).length === 2, 'two tasks');
    const parent = (): HTMLElement => taskRows(app).find((r) => r.title === 'Plan trip')!.el;

    await addSubtask(app, parent());
    await waitFor(() => taskRows(app).length === 3, 'the first subtask');
    await addSubtask(app, parent());
    await waitFor(() => taskRows(app).length === 4, 'the second subtask');

    const shown = ['Plan trip', 'Plan trip - Subtask 1', 'Plan trip - Subtask 2', 'Pack'];
    expect(taskRows(app).map((r) => r.title)).toEqual(shown);
    expect(taskRows(app).slice(1, 3).every((r) => taskIsSubtask(r.el))).toBe(true);
    await waitFor(
      () => savedTasks(app).map((t) => t.filePath.replace(/^.*\//, '').replace(/\.md$/, '')).join() === shown.join(),
      'the board saved in that order',
    );

    await undo(app);
    await waitFor(() => taskRows(app).length === 3, 'one subtask taken back');
    expect(taskRows(app).map((r) => r.title)).toEqual(['Plan trip', 'Plan trip - Subtask 1', 'Pack']);
  });

  it('a note that names a parent is shown nested; Shift+Tab outdents it without touching the note', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const parentNote = await quickAddTask(app, 'Plan trip');
    const childNote = await quickAddTask(app, 'Book hotel');
    await waitFor(() => taskRows(app).length === 2, 'two tasks');
    const parentId = taskFor(app, parentNote).tileId;
    const legacy = app.read(childNote).replace(/^---\n/, `---\nparent: ${parentId}\n`);
    app.writeExternally(childNote, legacy);
    await waitFor(() => taskIsSubtask(taskRows(app)[1]!.el), 'the task shown under its parent');

    await indentTask(taskRows(app)[1]!.el, true);
    await waitFor(() => !taskIsSubtask(taskRows(app)[1]!.el), 'the task at the top level');
    await waitFor(() => taskFor(app, childNote).parentTileId === '', 'the outdent saved on the board');
    await quiesce(600);
    expect(app.read(childNote)).toBe(legacy);
  });
});
