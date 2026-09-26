/**
 * Characterisation — the Task List notes box writes only what the user typed,
 * and only onto the body it was opened on.
 *
 * Opening the box and leaving it without typing writes nothing, even after the
 * note changed elsewhere. Typing after such a change asks (Keep mine backs the
 * other version up first) instead of writing the stale draft over it. A body
 * that opens with a rule block keeps it. A note that isn't UTF-8 gets a
 * read-only box.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, recoveryCopies } from './harness/app';
import {
  createBoard,
  taskRows,
  openTaskNotes,
  taskNotesText,
  taskNotesReadOnly,
  typeTaskNotes,
  leaveTaskNotes,
  toastTexts,
  toastActions,
  chooseToastAction,
  placeNoteOnBoard,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

function rowOf(app: Awaited<ReturnType<typeof startApp>>, title: string): HTMLElement {
  const row = taskRows(app).find((r) => r.title === title);
  if (!row) throw new Error(`no task row "${title}"`);
  return row.el;
}

async function taskWithBody(body: string): Promise<{ app: Awaited<ReturnType<typeof startApp>>; rel: string }> {
  // An existing note placed on the board: Filo hasn't written it, so a change
  // made by another program is seen at once.
  const rel = 'Water plants.md';
  const app = await startApp({ [rel]: `---\ntitle: Water plants\n---\n${body}` });
  await createBoard(app, 'tasklist');
  await placeNoteOnBoard(app, 'tasklist', rel);
  await waitFor(() => taskRows(app).some((r) => r.title === 'Water plants'), 'the task on the board');
  return { app, rel };
}

describe('task notes box', () => {
  it('leaving it untouched after a change elsewhere writes nothing', async () => {
    const { app, rel } = await taskWithBody('First version\n');
    const row = rowOf(app, 'Water plants');
    await openTaskNotes(row);
    expect(taskNotesText(row)).toBe('First version\n');

    const theirs = app.read(rel).replace('First version', 'Edited elsewhere');
    app.writeExternally(rel, theirs);
    await quiesce(1200);

    await leaveTaskNotes(row);
    await quiesce(800);
    expect(app.read(rel)).toBe(theirs);
  });

  it('typing after a change elsewhere asks first; Keep mine backs the other version up', async () => {
    const { app, rel } = await taskWithBody('First version\n');
    const row = rowOf(app, 'Water plants');
    await openTaskNotes(row);

    const theirs = app.read(rel).replace('First version', 'Edited elsewhere');
    app.writeExternally(rel, theirs);
    await quiesce(1200);

    await typeTaskNotes(row, 'My notes');
    await leaveTaskNotes(row);
    await waitFor(() => toastTexts().some((t) => t.includes('while its task notes were open')), 'the notes conflict prompt');
    expect(app.read(rel)).toBe(theirs);
    expect(taskNotesText(row)).toBe('My notes');

    expect(toastActions()).toContain('Keep mine');
    await chooseToastAction('Keep mine');
    await waitFor(() => app.read(rel).includes('My notes'), 'my notes on disk');
    expect([...recoveryCopies(app).values()].some((t) => t.includes('Edited elsewhere'))).toBe(true);
  });

  it('a body that opens with a rule block keeps it', async () => {
    const { app, rel } = await taskWithBody('---\nBetween two rules\n---\nMore\n');
    const row = rowOf(app, 'Water plants');
    await openTaskNotes(row);
    expect(taskNotesText(row)).toBe('---\nBetween two rules\n---\nMore\n');

    await typeTaskNotes(row, '---\nBetween two rules\n---\nMore, and a line\n');
    await leaveTaskNotes(row);
    await waitFor(() => app.read(rel).includes('More, and a line'), 'the notes on disk');
    expect(app.read(rel)).toMatch(/\n---\n---\nBetween two rules\n---\nMore, and a line\n$/);
  });

  it('a note that isn\'t UTF-8 gets a read-only box', async () => {
    const latin1 = new Uint8Array([...Buffer.from('---\ntitle: Old\n---\nCaf'), 0xe9, 0x0a]);
    const app = await startApp({ 'Old.md': latin1 });
    await createBoard(app, 'tasklist');
    await placeNoteOnBoard(app, 'tasklist', 'Old.md');
    await waitFor(() => taskRows(app).length === 1, 'the note on the board');
    const row = taskRows(app)[0]!.el;
    await openTaskNotes(row);
    await waitFor(() => taskNotesReadOnly(row), 'a read-only notes box');
  });
});
