/**
 * Characterisation: the vault name and the folder pins survive what happens
 * to them after they are set. A renamed vault keeps its name across a
 * reopen, and the Root Directory and a board's folder follow their folder
 * when another program renames it (Explorer reports that as one rename per
 * file inside it), instead of being reset to the vault root. A pinned folder
 * deleted in the sidebar clears its pins, and undo puts them back.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, reopenVault } from './harness/app';
import { createBoard, addKanbanColumn, addKanbanCard, errorToasts, deleteInSidebar, renameInSidebar, undo } from './harness/actions';
import {
  vaultName,
  renameVault,
  toggleRootDirectory,
  toggleBoardFolder,
  rootDirectoryFolder,
  boardFolder,
  setBoardFolders,
  filoReadsTreeNow,
} from './harness/vaultFolders';

afterEach(async () => {
  await stopApp();
});

describe('the vault name', () => {
  it('a renamed vault keeps its name after it is closed and opened again', async () => {
    const app = await startApp({ 'Note.md': 'Hello\n' });
    await renameVault(app, 'My Library');
    expect(vaultName(app)).toBe('My Library');

    await reopenVault(app);
    expect(vaultName(app)).toBe('My Library');
  });
});

describe('a pinned folder renamed by another program', () => {
  it('the Root Directory follows the folder, and still does after a reopen', async () => {
    const app = await startApp({ 'Old/a.md': 'A\n', 'Old/b.md': 'B\n' });
    await toggleRootDirectory(app, 'Old');
    expect(rootDirectoryFolder(app)).toBe('Old');

    app.renameExternally('Old', 'New');
    await waitFor(() => rootDirectoryFolder(app) === 'New', 'the Root Directory to follow the folder');
    await quiesce(1500);
    expect(rootDirectoryFolder(app)).toBe('New');
    expect(errorToasts()).toEqual([]);

    await reopenVault(app);
    expect(rootDirectoryFolder(app)).toBe('New');
  });

  it("a board's folder follows too, and the board's new cards land in it", async () => {
    const app = await startApp({ 'Old/a.md': 'A\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await setBoardFolders(app, true);
    await toggleBoardFolder(app, 'Old');
    expect(boardFolder(app)).toBe('Old');

    app.renameExternally('Old', 'New');
    await waitFor(() => boardFolder(app) === 'New', "the board's folder to follow");
    await quiesce(1500);

    const card = await addKanbanCard(app);
    expect(card.startsWith('New/')).toBe(true);
    expect(app.exists('Old')).toBe(false);
    expect(errorToasts()).toEqual([]);
  });

  it('a pin whose folder is deleted by another program is still cleared', async () => {
    const app = await startApp({ 'Old/a.md': 'A\n', 'Keep.md': 'K\n' });
    await toggleRootDirectory(app, 'Old');
    expect(rootDirectoryFolder(app)).toBe('Old');

    app.deleteExternally('Old');
    await waitFor(() => rootDirectoryFolder(app) === null, 'the Root Directory to be cleared');
    await quiesce(1500);
    expect(app.exists('Old')).toBe(false);
  });
});

describe('a pinned folder deleted in the sidebar', () => {
  it('the Root Directory is cleared, and undo puts it back', async () => {
    const app = await startApp({ 'Old/a.md': 'A\n', 'Keep.md': 'K\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await toggleRootDirectory(app, 'Old');
    expect(rootDirectoryFolder(app)).toBe('Old');

    await deleteInSidebar(app, 'Old');
    expect(app.exists('Old')).toBe(false);
    expect(rootDirectoryFolder(app)).toBe(null);

    await undo(app);
    await waitFor(() => app.exists('Old/a.md'), 'the folder back');
    await waitFor(() => rootDirectoryFolder(app) === 'Old', 'the Root Directory back');
    await quiesce(1500);
    expect(errorToasts()).toEqual([]);

    await reopenVault(app);
    expect(rootDirectoryFolder(app)).toBe('Old');
  });

  it("a board's folder is cleared, and undo puts it back", async () => {
    const app = await startApp({ 'Old/a.md': 'A\n', 'Keep.md': 'K\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await setBoardFolders(app, true);
    await toggleBoardFolder(app, 'Old');
    expect(boardFolder(app)).toBe('Old');

    await deleteInSidebar(app, 'Old');
    expect(app.exists('Old')).toBe(false);
    expect(boardFolder(app)).toBe(null);

    await undo(app);
    await waitFor(() => app.exists('Old/a.md'), 'the folder back');
    await waitFor(() => boardFolder(app) === 'Old', "the board's folder back");
    await quiesce(1500);
    expect(errorToasts()).toEqual([]);
  });
});

describe('a pinned folder renamed by another program just as Filo reads the tree', () => {
  it('the Root Directory still follows the folder', async () => {
    const app = await startApp({ 'Old/a.md': 'A\n', 'Old/b.md': 'B\n' });
    await toggleRootDirectory(app, 'Old');
    await quiesce(800);

    app.renameExternally('Old', 'New');
    await filoReadsTreeNow();
    await quiesce(1500);
    expect(rootDirectoryFolder(app)).toBe('New');
    expect(errorToasts()).toEqual([]);
  });
});

describe('a pinned folder renamed in Filo', () => {
  it('the moved Root Directory is saved before the rename is marked done', async () => {
    const app = await startApp({ 'Old/a.md': 'A\n' });
    await toggleRootDirectory(app, 'Old');
    await quiesce(800);
    app.bridge.resetLog();
    await renameInSidebar(app, 'Old', 'New');
    expect(rootDirectoryFolder(app)).toBe('New');

    const calls = app.bridge.calls;
    const saved = calls.findIndex((c) => c.channel === 'config:save' && c.args[1] === 'app.json' && String(c.args[2]).includes('"activeRootFolder": "New"'));
    const done = calls.findIndex((c) => c.channel === 'vault:delete' && String(c.args[1]).includes('rename-cascade'));
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(saved);
    expect(errorToasts()).toEqual([]);
  });
});
