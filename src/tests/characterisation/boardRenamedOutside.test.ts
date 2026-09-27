/**
 * Characterisation: a board renamed or moved by another program (Explorer, a
 * sync client) is followed. It keeps its tab and its tiles, takes the new
 * file's name, and nothing is written back at the old path, even when the
 * rename comes straight after Filo saved the board.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, type CharApp } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  addKanbanCard,
  activeTabName,
  kanbanCards,
  errorToasts,
  toastTexts,
} from './harness/actions';
import { setBoardFolders, boardFolder } from './harness/vaultFolders';

afterEach(async () => {
  await stopApp();
});

function boardNameOnDisk(app: CharApp, rel: string): string {
  return (JSON.parse(app.read(rel)) as { board: { name: string } }).board.name;
}

function duplicateIdWarning(): boolean {
  return toastTexts().some((t) => t.includes('Two board files use the same id'));
}

function unsavedMissingPrompt(): boolean {
  return toastTexts().some((t) => t.includes('moved or deleted outside Filo'));
}

describe('a .board.json renamed by another program', () => {
  it('the board takes the new name, and its next save writes that name into the new file only', async () => {
    const app = await startApp({ 'Keep.md': 'K\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await quiesce();

    app.renameExternally('Kanban 1.board.json', 'Roadmap.board.json');
    await waitFor(() => activeTabName(app) === 'Roadmap', 'the tab to take the new name');

    await addKanbanCard(app);
    await waitFor(() => boardNameOnDisk(app, 'Roadmap.board.json') === 'Roadmap', 'the new name in the board file');
    await quiesce();
    expect(app.exists('Kanban 1.board.json')).toBe(false);
    expect(kanbanCards(app)).toHaveLength(1);
    expect(errorToasts()).toEqual([]);
  });

  it('straight after a save: still followed, with no duplicate-id warning and nothing at the old path', async () => {
    const app = await startApp({ 'Keep.md': 'K\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanCard(app);
    // The card's save is on disk; the rename lands inside the window where
    // the watcher still remembered the file from before that save.
    await waitFor(() => app.read('Kanban 1.board.json').includes('tilePlacements'), 'the card saved');
    await quiesce(600);

    app.renameExternally('Kanban 1.board.json', 'Roadmap.board.json');
    await waitFor(() => activeTabName(app) === 'Roadmap', 'the tab to follow the rename');
    await quiesce(4000);

    expect(duplicateIdWarning()).toBe(false);
    expect(app.exists('Kanban 1.board.json')).toBe(false);
    expect(kanbanCards(app)).toHaveLength(1);
    expect(errorToasts()).toEqual([]);
  });

  it('a board folder renamed straight after a save: the board and its folder pin follow, with no prompt', async () => {
    const app = await startApp({ 'Keep.md': 'K\n' });
    await setBoardFolders(app, true);
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanCard(app);
    await quiesce(600);

    app.renameExternally('Kanban 1', 'Work');
    await waitFor(() => boardFolder(app) === 'Work', 'the folder pin to follow the folder');
    await quiesce(4000);

    expect(unsavedMissingPrompt()).toBe(false);
    expect(duplicateIdWarning()).toBe(false);
    expect(app.exists('Kanban 1')).toBe(false);
    expect(app.exists('Work/Kanban 1.board.json')).toBe(true);
    expect(kanbanCards(app)).toHaveLength(1);
    expect(errorToasts()).toEqual([]);
  });
});
