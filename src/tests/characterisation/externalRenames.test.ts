/**
 * Characterisation — a rename made by another program (Explorer, a sync
 * client, `git mv`) is followed, even while the note has an edit that hasn't
 * reached the disk yet, and even right after Filo wrote the file.
 *
 * The typed text lands in the moved file, nothing comes back at the old name,
 * and no "deleted" prompt or error appears. A real delete still asks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseDocument } from 'yaml';
import { startApp, stopApp, waitFor, quiesce, type CharApp } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  placeNoteOnBoard,
  kanbanCards,
  setCardDueDate,
  openNoteFromSidebar,
  showBoard,
  activeTabName,
  boardFilesText,
  editors,
  typeAtEnd,
  undo,
  errorToasts,
  toastTexts,
  diskConflictPrompt,
  chooseToastAction,
  toastActions,
  $$,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

function docEditor(app: CharApp): ReturnType<typeof editors>[number] {
  return editors($$(app.el, '.document-board')[0])[0];
}

function deletedPromptShown(): boolean {
  return toastTexts().some((t) => t.includes('was deleted by another program') || t.includes('no longer exists'));
}

function frontmatter(app: CharApp, rel: string): Record<string, unknown> {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(app.read(rel));
  if (!m) return {};
  return (parseDocument(m[1]).toJS() ?? {}) as Record<string, unknown>;
}

describe('a rename by another program while the note has an unsaved edit', () => {
  it('Document tab: the typed text lands in the moved file, and the tab follows it', async () => {
    const app = await startApp({ 'Draft.md': 'Start\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();

    await typeAtEnd(docEditor(app), ' typed');
    app.renameExternally('Draft.md', 'Moved.md');

    await waitFor(() => app.exists('Moved.md') && app.read('Moved.md').includes('Start typed'), 'the typed text in the moved file');
    await quiesce(1500);
    expect(app.exists('Draft.md')).toBe(false);
    expect(deletedPromptShown()).toBe(false);
    expect(diskConflictPrompt()).toBe(false);
    expect(errorToasts()).toEqual([]);
    await waitFor(() => activeTabName(app) === 'Moved', 'the tab to show the new name');

    await typeAtEnd(docEditor(app), ' more');
    await waitFor(() => app.read('Moved.md').includes('Start typed more'), 'further typing in the moved file');
    await quiesce();
    expect(app.exists('Draft.md')).toBe(false);
    expect(errorToasts()).toEqual([]);
  });

  it('the note on a Kanban board too: the card follows, and the board file names the new path', async () => {
    const app = await startApp({ 'Draft.md': 'Start\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Draft.md');
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();

    await typeAtEnd(docEditor(app), ' typed');
    app.renameExternally('Draft.md', 'Moved.md');

    await waitFor(() => app.exists('Moved.md') && app.read('Moved.md').includes('Start typed'), 'the typed text in the moved file');
    await waitFor(() => boardFilesText(app).some((t) => t.includes('Moved.md')), 'the board file to name the new path');
    await quiesce(1500);
    expect(app.exists('Draft.md')).toBe(false);
    expect(boardFilesText(app).some((t) => t.includes('Draft.md'))).toBe(false);
    expect(deletedPromptShown()).toBe(false);
    expect(errorToasts()).toEqual([]);

    await showBoard(app, 'kanban');
    await waitFor(() => kanbanCards(app)[0]?.title === 'Moved', 'the card to show the moved note');
  });

  it('a case-only rename keeps the text and asks nothing', async () => {
    const app = await startApp({ 'Draft.md': 'Start\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();

    await typeAtEnd(docEditor(app), ' typed');
    app.renameExternally('Draft.md', 'draft.md');

    await waitFor(() => app.read('draft.md').includes('Start typed'), 'the typed text on disk');
    await quiesce(2500);
    expect(app.userFiles()).toEqual(['draft.md']);
    expect(deletedPromptShown()).toBe(false);
    expect(diskConflictPrompt()).toBe(false);
    expect(errorToasts()).toEqual([]);
  });

  it('a delete (not a rename) while the note has an unsaved edit still asks', async () => {
    const app = await startApp({ 'Draft.md': 'Start\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();

    await typeAtEnd(docEditor(app), ' typed');
    app.deleteExternally('Draft.md');

    await waitFor(() => deletedPromptShown(), 'the deleted prompt');
    await quiesce();
    expect(app.exists('Draft.md')).toBe(false);

    // Answer it (the edit is let go), so closing the vault has nothing left to ask about.
    await chooseToastAction(toastActions().find((l) => l.startsWith('Discard')) ?? 'Discard');
    expect(app.exists('Draft.md')).toBe(false);
  });
});

describe('a rename by another program just after Filo wrote the note', () => {
  it('is followed, not taken for Filo\'s own write', async () => {
    const app = await startApp({ 'Draft.md': 'Start\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();
    await typeAtEnd(docEditor(app), ' typed');
    await waitFor(() => app.read('Draft.md').includes('Start typed'), 'the edit on disk');
    await quiesce(500);

    app.renameExternally('Draft.md', 'Moved.md');
    await waitFor(() => activeTabName(app) === 'Moved', 'the tab to follow the rename');

    await typeAtEnd(docEditor(app), ' more');
    await waitFor(() => app.exists('Moved.md') && app.read('Moved.md').includes('Start typed more'), 'further typing in the moved file');
    await quiesce();
    expect(app.exists('Draft.md')).toBe(false);
    expect(deletedPromptShown()).toBe(false);
    expect(errorToasts()).toEqual([]);
  });

  it('board undo lands on the moved note', async () => {
    const app = await startApp({ 'Card.md': '---\ntitle: Card\n---\nCard body\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Card.md');
    await setCardDueDate(kanbanCards(app)[0].el, '2026-11-05');
    expect(String(frontmatter(app, 'Card.md').dueDate)).toBe('2026-11-05');

    app.renameExternally('Card.md', 'Renamed.md');
    await waitFor(() => boardFilesText(app).some((t) => t.includes('Renamed.md')), 'the board to follow the rename');

    await undo(app);
    await waitFor(() => frontmatter(app, 'Renamed.md').dueDate === undefined, 'the due date gone from the moved note');
    await quiesce();
    expect(app.exists('Card.md')).toBe(false);
    expect(errorToasts()).toEqual([]);
  });
});
