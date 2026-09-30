/**
 * Characterisation: a rename that takes a while (Windows retries a locked
 * folder for seconds) or is refused in the end. Boards change only once the
 * files have moved: nothing is written with the new name while the rename is
 * out, a refused rename leaves every board as it was on disk (and keeps an
 * edit made meanwhile), and a board whose folder is renamed never gets a
 * second copy. An undo doesn't wait for the watcher's queue, and a save
 * waiting on a slow undo says so.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, reopenVault, settle, waitFor, type CharApp } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  addKanbanCard,
  placeNoteOnBoard,
  kanbanCards,
  deleteInSidebar,
  pressShortcut,
  errorToasts,
  toastTexts,
} from './harness/actions';
import { setBoardFolders, toggleRootDirectory } from './harness/vaultFolders';
import {
  holdNextMainCall,
  namesPath,
  startSidebarRename,
  startActiveBoardRename,
  addKanbanColumnNow,
  keepWatcherQueueBusy,
  releaseHeldCalls,
} from './harness/slowDisk';

afterEach(async () => {
  releaseHeldCalls();
  await stopApp();
});

interface BoardOnDisk {
  links: string[];
  columns: number;
}

/** The note links and column count of the board file at `rel`, as on disk. */
function boardOnDisk(app: CharApp, rel: string): BoardOnDisk {
  const text = app.read(rel);
  const links = [...text.matchAll(/"filePath":\s*"([^"]+)"/g)].map((m) => m[1]);
  const board = (JSON.parse(text) as { board: { columns?: unknown[] } }).board;
  return { links, columns: board.columns?.length ?? 0 };
}

/** A Kanban board with one card whose note is in the `Notes` folder. */
async function boardWithCardInNotes(): Promise<{ app: CharApp; boardRel: string; card: string }> {
  const app = await startApp({ 'Notes/n.md': 'N\n' });
  await createBoard(app, 'kanban');
  await addKanbanColumn(app);
  await toggleRootDirectory(app, 'Notes');
  const card = await addKanbanCard(app);
  expect(card.startsWith('Notes/')).toBe(true);
  await quiesce(1000);
  const boardRel = app.userFiles().find((p) => p.endsWith('.board.json'));
  if (!boardRel) throw new Error('no board file');
  return { app, boardRel, card };
}

describe('a folder rename that takes a while', () => {
  it('writes the new links only once the folder has moved', async () => {
    const { app, boardRel, card } = await boardWithCardInNotes();
    const rename = holdNextMainCall('vault:rename', namesPath(app, 'Notes'));
    await startSidebarRename(app, 'Notes', 'Notes2');
    await rename.reached;
    await settle(900); // longer than a board's save debounce
    expect(boardOnDisk(app, boardRel).links).toEqual([card]);

    rename.release();
    await quiesce(1500);
    expect(app.exists('Notes2/New Card.md')).toBe(true);
    expect(boardOnDisk(app, boardRel).links).toEqual([card.replace(/^Notes\//, 'Notes2/')]);
    expect(errorToasts()).toEqual([]);
  });

  it('refused in the end: the board keeps its links on disk, and an edit made meanwhile', async () => {
    const { app, boardRel, card } = await boardWithCardInNotes();
    const rename = holdNextMainCall('vault:rename', namesPath(app, 'Notes'));
    await startSidebarRename(app, 'Notes', 'Notes2');
    await rename.reached;
    await addKanbanColumnNow(app);
    await settle(900);

    rename.refuseAsLocked();
    await quiesce(1500);
    expect(app.exists('Notes')).toBe(true);
    expect(app.exists('Notes2')).toBe(false);
    expect(boardOnDisk(app, boardRel)).toEqual({ links: [card], columns: 2 });

    await reopenVault(app);
    await quiesce(1000);
    expect(boardOnDisk(app, boardRel)).toEqual({ links: [card], columns: 2 });
    expect(kanbanCards(app)).toHaveLength(1);
  });
});

describe("a board rename whose folder rename takes a while", () => {
  it('moves the folder, and leaves no second copy of the board', async () => {
    const app = await startApp({ 'Keep.md': 'K\n' });
    await setBoardFolders(app, true);
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const card = await addKanbanCard(app);
    await quiesce(800);

    // The board's file is renamed first, then its folder: hold the folder.
    const folderRename = holdNextMainCall('vault:rename', namesPath(app, 'Kanban 1'));
    await startActiveBoardRename(app, 'Plan');
    await folderRename.reached;
    await settle(900);
    expect(app.exists('Plan')).toBe(false);

    folderRename.release();
    await quiesce(2000);
    expect(app.exists('Kanban 1')).toBe(false);
    expect(app.exists('Plan/Plan.board.json')).toBe(true);
    const moved = card.replace(/^Kanban 1\//, 'Plan/');
    expect(app.exists(moved)).toBe(true);
    expect(boardOnDisk(app, 'Plan/Plan.board.json').links).toEqual([moved]);
    expect(errorToasts()).toEqual([]);

    await reopenVault(app);
    await quiesce(1000);
    expect(kanbanCards(app)).toHaveLength(1);
    expect(toastTexts().some((t) => /same id/i.test(t))).toBe(false);
  });
});

describe('undo while the watcher is busy', () => {
  it("a deleted card's undo brings it back without waiting for the watcher's queue", async () => {
    const app = await startApp({ 'Card.md': '---\ntitle: Card\n---\nCard body\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Card.md');
    await deleteInSidebar(app, 'Card.md');
    expect(kanbanCards(app)).toHaveLength(0);

    const queue = await keepWatcherQueueBusy(8000);
    const started = Date.now();
    (document.activeElement as HTMLElement | null)?.blur?.();
    pressShortcut('z', { ctrlKey: true });
    await waitFor(() => kanbanCards(app).length === 1, 'the card back', 3000);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(app.read('Card.md')).toContain('Card body');

    await queue.free;
    await quiesce(1000);
    expect(kanbanCards(app)).toHaveLength(1);
    expect(errorToasts()).toEqual([]);
  });

  it('a save that waits on a slow undo says what it is waiting for', async () => {
    const app = await startApp({ 'Card.md': '---\ntitle: Card\n---\nCard body\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Card.md');
    await deleteInSidebar(app, 'Card.md');

    const restore = holdNextMainCall('vault:trash-restore');
    (document.activeElement as HTMLElement | null)?.blur?.();
    pressShortcut('z', { ctrlKey: true });
    await restore.reached;
    pressShortcut('s', { ctrlKey: true });
    await waitFor(() => toastTexts().some((t) => t.startsWith('Finishing the last undo')), 'the waiting notice', 5000);

    restore.release();
    await waitFor(() => kanbanCards(app).length === 1, 'the card back');
    await waitFor(() => !toastTexts().some((t) => t.startsWith('Finishing the last undo')), 'the notice gone');
    await quiesce(1000);
    expect(errorToasts()).toEqual([]);
  });
});
