/**
 * Characterisation — board undo follows a note that was renamed or moved after
 * the edit, and an undo whose note is gone never blocks the rest of the vault.
 *
 * The undo lands on the note at its new name; nothing is written at the old
 * name, and no error is shown.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseDocument } from 'yaml';
import { startApp, stopApp, waitFor, quiesce, type CharApp } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  quickAddTask,
  placeNoteOnBoard,
  kanbanCards,
  taskRows,
  setCardDueDate,
  toggleTask,
  renameTileTitle,
  renameInSidebar,
  openNoteFromSidebar,
  typeInTagRow,
  tagRowTags,
  undo,
  errorToasts,
  toastTexts,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

/** The note's frontmatter as data (the `yaml` package, as the app reads it). */
function frontmatter(app: CharApp, rel: string): Record<string, unknown> {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(app.read(rel));
  if (!m) return {};
  return (parseDocument(m[1]).toJS() ?? {}) as Record<string, unknown>;
}

describe('undo after a sidebar rename', () => {
  it('Kanban due date: undo clears it on the renamed note and recreates nothing', async () => {
    const app = await startApp({ 'Card.md': '---\ntitle: Card\n---\nCard body\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Card.md');
    await setCardDueDate(kanbanCards(app)[0].el, '2026-11-05');
    expect(String(frontmatter(app, 'Card.md').dueDate)).toBe('2026-11-05');

    await renameInSidebar(app, 'Card.md', 'Renamed');
    await waitFor(() => app.exists('Renamed.md'), 'the renamed file');

    await undo(app);
    await waitFor(() => frontmatter(app, 'Renamed.md').dueDate === undefined, 'the due date gone from the renamed note');
    await quiesce();
    expect(app.exists('Card.md')).toBe(false);
    expect(app.read('Renamed.md')).toContain('Card body');
    expect(errorToasts()).toEqual([]);
  });

  it('Task List tick: undo unticks the renamed note', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const note = await quickAddTask(app, 'Buy milk');
    await toggleTask(taskRows(app)[0].el);
    expect(frontmatter(app, note).completed).toBe(true);

    await renameInSidebar(app, note, 'Groceries');
    await waitFor(() => app.exists('Groceries.md'), 'the renamed file');

    await undo(app);
    await waitFor(() => frontmatter(app, 'Groceries.md').completed === false, 'the task unticked on disk');
    await quiesce();
    expect(app.exists(note)).toBe(false);
    expect(errorToasts()).toEqual([]);
  });

  it('tile title edit: undo puts the old title back in the renamed note', async () => {
    const app = await startApp({ 'Card.md': '---\ntitle: Card\n---\nCard body\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Card.md');
    await renameTileTitle(kanbanCards(app)[0].el, 'Better title');
    await waitFor(() => frontmatter(app, 'Card.md').title === 'Better title', 'the new title on disk');

    await renameInSidebar(app, 'Card.md', 'Moved');
    await waitFor(() => app.exists('Moved.md'), 'the renamed file');

    await undo(app);
    await waitFor(() => frontmatter(app, 'Moved.md').title === 'Card', 'the old title back on disk');
    await quiesce();
    expect(app.exists('Card.md')).toBe(false);
    expect(errorToasts()).toEqual([]);
  });

  it('tag row (Properties) edit in a Document tab: undo takes the tag off the renamed note', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\ntags: [work]\n---\nBody\n' });
    await openNoteFromSidebar(app, 'Plan.md');
    await typeInTagRow(app, 'extra');
    await waitFor(() => app.read('Plan.md').includes('extra'), 'the tag on disk');

    await renameInSidebar(app, 'Plan.md', 'Plan 2');
    await waitFor(() => app.exists('Plan 2.md'), 'the renamed file');

    await undo(app);
    await waitFor(() => !app.read('Plan 2.md').includes('extra'), 'the tag gone from the renamed note');
    await quiesce();
    expect(app.exists('Plan.md')).toBe(false);
    expect(tagRowTags(app)).toEqual(['work']);
    expect(errorToasts()).toEqual([]);
  });

  it('folder rename: undo lands on the note in the renamed folder', async () => {
    const app = await startApp({ 'Work/Card.md': '---\ntitle: Card\n---\nCard body\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Work/Card.md');
    await setCardDueDate(kanbanCards(app)[0].el, '2026-11-05');
    expect(String(frontmatter(app, 'Work/Card.md').dueDate)).toBe('2026-11-05');

    await renameInSidebar(app, 'Work', 'Projects');
    await waitFor(() => app.exists('Projects/Card.md'), 'the renamed folder');

    await undo(app);
    await waitFor(() => frontmatter(app, 'Projects/Card.md').dueDate === undefined, 'the due date gone');
    await quiesce();
    expect(app.exists('Work/Card.md')).toBe(false);
    expect(app.exists('Work')).toBe(false);
    expect(errorToasts()).toEqual([]);
  });
});

describe('undo on a note that is gone', () => {
  it('says so, writes nothing, and leaves renames of other notes working', async () => {
    const app = await startApp({
      'Card.md': '---\ntitle: Card\n---\nCard body\n',
      'Other.md': '---\ntitle: Other\n---\nOther body\n',
    });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Card.md');
    await setCardDueDate(kanbanCards(app)[0].el, '2026-11-05');
    // The watcher takes a change to a file Filo just wrote as its own echo
    // for a few seconds; the other program acts after that.
    await quiesce(8000);

    app.deleteExternally('Card.md');
    await waitFor(() => toastTexts().some((t) => t.includes('is missing from the vault')), 'the app to see the delete');

    await undo(app);
    await waitFor(() => toastTexts().includes(`Couldn't undo: "Card.md" no longer exists.`), 'the "no longer exists" toast');
    await quiesce();
    expect(app.exists('Card.md')).toBe(false);
    expect(errorToasts()).toEqual([]);

    await renameInSidebar(app, 'Other.md', 'Other renamed');
    await waitFor(() => app.exists('Other renamed.md'), 'the unrelated rename');
    expect(app.exists('Other.md')).toBe(false);
    expect(toastTexts().some((t) => t.includes("Couldn't complete the operation"))).toBe(false);
  });
});
