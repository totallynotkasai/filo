/**
 * Characterisation — the save state tells the truth: layout state Filo keeps
 * for itself saves without a false alarm, and what does fail can be retried.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, closeVault, reopenVault, waitFor } from './harness/app';
import {
  $$,
  createBoard,
  errorToasts,
  diskConflictPrompt,
  reloadFromDisk,
  addKanbanColumn,
  placeNoteOnBoard,
  openNoteFromSidebar,
  editors,
  typeAtEnd,
  activeTabName,
  boardFilesText,
  keepMine,
  toastTexts,
  toastActions,
  recoveryPromptShown,
} from './harness/actions';
import {
  dragKanbanToolbar,
  kanbanToolbarPosition,
  kanbanToolbarPinned,
  toggleKanbanToolbarPin,
  savedBoardToolbars,
  onlyBoardFile,
  clickAddKanbanColumn,
  kanbanColumnTitles,
  whileSaveReads,
  saveIndicator,
  dismissAllToasts,
  openSavePopover,
  showHeldDecision,
  recoveryModal,
} from './harness/saveState';

afterEach(async () => {
  await stopApp();
});

describe('the Kanban side toolbar', () => {
  it('a drag is saved with the workspace, and close asks nothing', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await dragKanbanToolbar(app, 140, 90);
    expect(kanbanToolbarPosition(app)).toEqual({ x: 140, y: 90 });
    await quiesce();

    expect(errorToasts()).toEqual([]);
    expect(savedBoardToolbars(app)).toEqual([{ position: { x: 140, y: 90 }, pinned: false }]);

    const result = await closeVault(app);
    expect(result.done).toBe(true);
    expect(result.dialogs).toEqual([]);
  });

  it('comes back where it was left when the vault is reopened', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await dragKanbanToolbar(app, 200, 120);
    await reopenVault(app);
    expect(kanbanToolbarPosition(app)).toEqual({ x: 200, y: 120 });
  });

  it('a pinned toolbar stays put, and is still pinned when the vault is reopened', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await dragKanbanToolbar(app, 200, 120);
    await toggleKanbanToolbarPin(app);
    await dragKanbanToolbar(app, 400, 300);
    expect(kanbanToolbarPosition(app)).toEqual({ x: 200, y: 120 });

    await reopenVault(app);
    expect(kanbanToolbarPinned(app)).toBe(true);
    expect(kanbanToolbarPosition(app)).toEqual({ x: 200, y: 120 });
    expect(savedBoardToolbars(app)).toEqual([{ position: { x: 200, y: 120 }, pinned: true }]);
  });
});

describe('a board changed outside Filo while it has unsaved changes', () => {
  it('Reload shows the disk version, writes nothing over it, and asks nothing more', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await clickAddKanbanColumn(app);
    await quiesce();
    const rel = onlyBoardFile(app);
    const onDisk = JSON.parse(app.read(rel)) as { board: { columns: Array<{ title: string }> } };
    const columnCount = onDisk.board.columns.length;
    expect(columnCount).toBeGreaterThan(0);
    onDisk.board.columns[0].title = 'Theirs';
    const theirs = JSON.stringify(onDisk, null, 2);

    // Another program saves the board; before Filo has saved, a column is added.
    app.writeExternally(rel, theirs);
    await clickAddKanbanColumn(app);
    await waitFor(() => diskConflictPrompt(), 'the board drift prompt');
    await reloadFromDisk();
    await quiesce();

    const titles = kanbanColumnTitles(app);
    expect(titles).toHaveLength(columnCount);
    expect(titles[0]).toBe('Theirs');
    expect(JSON.parse(app.read(rel))).toEqual(JSON.parse(theirs));
    expect(diskConflictPrompt()).toBe(false);
    expect(errorToasts()).toEqual([]);

    const result = await closeVault(app);
    expect(result.dialogs).toEqual([]);
  });
});

describe('a note renamed by another program while its save is out', () => {
  it('the save lands at the new path, nothing is left failed, and the card follows', async () => {
    const app = await startApp({ 'Draft.md': 'Start\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Draft.md');
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();

    await typeAtEnd(editors($$(app.el, '.document-board')[0])[0], ' typed');
    await whileSaveReads(app, 'Draft.md', async () => {
      app.renameExternally('Draft.md', 'Moved.md');
      await waitFor(() => activeTabName(app) === 'Moved', 'the tab to follow the rename');
    });

    await waitFor(() => app.exists('Moved.md') && app.read('Moved.md').includes('Start typed'), 'the typed text in the moved file');
    await waitFor(() => boardFilesText(app).some((t) => t.includes('Moved.md')), 'the board file to name the new path');
    await quiesce(1500);
    expect(app.exists('Draft.md')).toBe(false);
    expect(errorToasts()).toEqual([]);

    const result = await closeVault(app);
    expect(result.dialogs).toEqual([]);
  });
});

describe("a change held for the user's decision", () => {
  it('the indicator waits for the answer instead of spinning, and its popover shows the prompt again', async () => {
    const app = await startApp({ 'Draft.md': '---\ntitle: Draft\n---\nStart\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();

    await typeAtEnd(editors($$(app.el, '.document-board')[0])[0], ' mine');
    app.writeExternally('Draft.md', '---\ntitle: Draft\n---\nStart theirs\n');
    await waitFor(() => diskConflictPrompt(), 'the disk-conflict prompt');
    await quiesce();
    expect(saveIndicator(app)).toBe('attention');

    // The prompt scrolled away: the popover brings it back.
    await dismissAllToasts();
    expect(diskConflictPrompt()).toBe(false);
    const rows = await openSavePopover(app);
    expect(rows.some((r) => r.includes('Draft.md') && r.includes('Reload or Keep mine'))).toBe(true);
    await showHeldDecision('Draft.md');
    expect(diskConflictPrompt()).toBe(true);

    await keepMine();
    await quiesce();
    expect(app.read('Draft.md')).toBe('---\ntitle: Draft\n---\nStart mine\n');
    expect(saveIndicator(app)).toBe('saved');
  });
});

describe('leaving a vault with unsaved work', () => {
  it('the rescue notice is still on screen after the vault closes, and the next open lists what to check', async () => {
    const app = await startApp({ 'Note.md': '---\ntitle: Note\n---\nFirst line\n' });
    await openNoteFromSidebar(app, 'Note.md');
    await typeAtEnd(editors($$(app.el, '.document-board')[0])[0], ' unsaved words');
    app.deleteExternally('Note.md');

    const result = await closeVault(app, 'Close anyway');
    expect(result.done).toBe(true);
    expect(toastTexts().some((t) => t.includes('.filo/recovery/'))).toBe(true);
    expect(toastActions()).toContain('Show in folder');

    // Reopening: the modal names the file in plain words, offers Open, and
    // points at the rescue folder written on the way out.
    await reopenVault(app);
    await waitFor(() => recoveryPromptShown(), 'the recovery modal');
    const modal = recoveryModal();
    expect(modal.text).toContain("Filo didn't finish saving these files last time");
    expect(modal.rows.some((r) => r.includes('Note.md'))).toBe(true);
    expect(modal.buttons).toContain('Open');
    await waitFor(() => recoveryModal().rows.some((r) => r.startsWith('Copies of unsaved work')), 'the rescue folder row');
    expect(recoveryModal().buttons).toContain('Show in folder');
  });
});
