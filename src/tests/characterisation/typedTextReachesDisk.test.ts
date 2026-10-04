/**
 * Characterisation — text being typed reaches the file without the user
 * having to leave the field, and the answers that throw typing away keep a
 * copy of it first.
 *
 * The Raw view and a task's notes box save once typing pauses. Escape in the
 * notes box saves and closes it, as clicking away does. Ctrl+S saves a task
 * title still being typed. Reload in the "changed by another program" prompt
 * keeps what was typed in `.filo/recovery/` and offers Undo reload.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, recoveryCopies } from './harness/app';
import {
  createBoard,
  quickAddTask,
  taskRows,
  openTaskNotes,
  typeTaskNotes,
  escapeTaskNotes,
  taskNotesOpen,
  startTaskTitleEdit,
  openNoteFromSidebar,
  editors,
  typeAtEnd,
  diskConflictPrompt,
  reloadFromDisk,
  chooseToastAction,
  toastActions,
  toggleRawView,
  rawText,
  typeInRawView,
  $$,
} from './harness/actions';
import { typeAtFocus, pressAtFocus } from './harness/typingFocus';

afterEach(async () => {
  await stopApp();
});

describe('a task', () => {
  it("Escape in a task's notes box saves what was typed and closes the box", async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const rel = await quickAddTask(app, 'Water plants');
    const row = taskRows(app)[0]!.el;
    await openTaskNotes(row);
    await typeTaskNotes(row, 'Use the rain barrel');
    await escapeTaskNotes(row);
    await quiesce();

    expect(taskNotesOpen(row)).toBe(false);
    expect(app.read(rel)).toContain('Use the rain barrel');
  });

  it("a task's notes box saves once typing pauses, without leaving it", async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const rel = await quickAddTask(app, 'Water plants');
    const row = taskRows(app)[0]!.el;
    await openTaskNotes(row);
    await typeTaskNotes(row, 'Use the rain barrel');
    await quiesce(2500);

    expect(taskNotesOpen(row)).toBe(true);
    expect(app.read(rel)).toContain('Use the rain barrel');
  });

  it('Ctrl+S saves a task title still being typed', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const rel = await quickAddTask(app, 'Water plants');
    const row = taskRows(app)[0]!.el;
    await startTaskTitleEdit(row);
    await typeAtFocus(' and the herbs');
    await pressAtFocus('s', { ctrlKey: true });
    await quiesce();

    expect(app.read(rel)).toContain('title: Water plants and the herbs');
  });
});

describe('the Raw view', () => {
  it('saves once typing pauses, without leaving the field', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\n---\nOld\n' });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await rawText(app);
    await typeInRawView(app, '---\ntitle: Plan\n---\nTyped as text\n');
    await quiesce(2500);

    expect(app.read('Plan.md')).toBe('---\ntitle: Plan\n---\nTyped as text\n');
  });
});

describe('Reload in the "changed by another program" prompt', () => {
  it('keeps what was typed in .filo/recovery/, and Undo reload puts it back', async () => {
    const app = await startApp({ 'Draft.md': '---\ntitle: Draft\n---\nStart\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();
    const [editor] = editors($$(app.el, '.document-board')[0]);
    app.writeExternally('Draft.md', '---\ntitle: Draft\n---\nStart, from the phone\n');
    await typeAtEnd(editor!, ' and two paragraphs typed here');
    await waitFor(() => diskConflictPrompt(), 'the disk-conflict prompt');

    await reloadFromDisk();
    await quiesce();
    expect(app.read('Draft.md')).toBe('---\ntitle: Draft\n---\nStart, from the phone\n');
    expect(editor!.getText()).toBe('Start, from the phone');
    const kept = [...recoveryCopies(app)].filter(([path]) => /-keep\//.test(path));
    expect(kept.map(([, text]) => text)).toContainEqual(expect.stringContaining('Start and two paragraphs typed here'));

    expect(toastActions()).toContain('Undo reload');
    await chooseToastAction('Undo reload');
    await quiesce();
    expect(app.read('Draft.md')).toContain('Start and two paragraphs typed here');
    // The phone's version was backed up before Undo reload wrote over it.
    expect([...recoveryCopies(app).values()]).toContain('---\ntitle: Draft\n---\nStart, from the phone\n');
  });
});
