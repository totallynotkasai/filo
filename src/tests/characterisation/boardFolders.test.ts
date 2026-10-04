/**
 * Characterisation: a board's name is its file name, and with board-specific
 * folders on each board keeps its file, and everything it creates, in a
 * folder of its own. The folder follows a board rename only while it is still
 * named after the board; renaming the `.board.json` renames the board; a name
 * the file system can't take, or another board's name, is refused.
 *
 * A new vault has board-specific folders on; an existing vault keeps what its
 * `app.json` says (off when it doesn't say).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, type CharApp } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  addKanbanCard,
  activeTabName,
  renameInSidebar,
  errorToasts,
} from './harness/actions';
import {
  setBoardFolders,
  boardFolder,
  toggleRootDirectory,
  renameActiveBoard,
  activeBoardRenameMessage,
} from './harness/vaultFolders';

afterEach(async () => {
  await stopApp();
});

function boardNameOnDisk(app: CharApp, rel: string): string {
  return (JSON.parse(app.read(rel)) as { board: { name: string } }).board.name;
}

async function kanbanWithFolders(files: Record<string, string> = {}): Promise<CharApp> {
  const app = await startApp({ 'Keep.md': 'K\n', ...files });
  await setBoardFolders(app, true);
  await createBoard(app, 'kanban');
  await addKanbanColumn(app);
  return app;
}

describe('a new vault', () => {
  it("has board-specific folders on: its first board makes its own folder, and its cards land there", async () => {
    const app = await startApp({ 'Chapter 1.md': 'It begins.\n' });
    expect((JSON.parse(app.read('.filo/app.json')) as { boardFolders?: unknown }).boardFolders).toBe(true);
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const card = await addKanbanCard(app);

    expect(app.exists('Kanban 1/Kanban 1.board.json')).toBe(true);
    expect(boardFolder(app)).toBe('Kanban 1');
    expect(card.startsWith('Kanban 1/')).toBe(true);
    expect(app.exists(card)).toBe(true);
    expect(app.userFiles().filter((f) => !f.includes('/'))).toEqual(['Chapter 1.md']);
    expect(errorToasts()).toEqual([]);
  });

  it("an existing vault whose app.json doesn't name them keeps them off", async () => {
    const app = await startApp({ '.filo/app.json': '{}\n', 'Chapter 1.md': 'It begins.\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const card = await addKanbanCard(app);

    expect(app.exists('Kanban 1.board.json')).toBe(true);
    expect(card.includes('/')).toBe(false);
    expect(errorToasts()).toEqual([]);
  });
});

describe('with board-specific folders on', () => {
  it('a new board gets a folder named after it, holding its file, and is its folder pin', async () => {
    const app = await kanbanWithFolders();
    expect(activeTabName(app)).toBe('Kanban 1');
    expect(app.exists('Kanban 1/Kanban 1.board.json')).toBe(true);
    expect(app.exists('Kanban 1.board.json')).toBe(false);
    expect(boardFolder(app)).toBe('Kanban 1');
    expect(errorToasts()).toEqual([]);
  });

  it("a new card lands in the board's folder", async () => {
    const app = await kanbanWithFolders();
    const card = await addKanbanCard(app);
    expect(card.startsWith('Kanban 1/')).toBe(true);
    expect(app.exists(card)).toBe(true);
  });

  it('renaming the board renames its file and its folder, and its cards go with them', async () => {
    const app = await kanbanWithFolders();
    const card = await addKanbanCard(app);
    await renameActiveBoard(app, 'Plan');
    await waitFor(() => app.exists('Plan/Plan.board.json'), 'the board file in its renamed folder');
    await quiesce(1500);

    expect(activeTabName(app)).toBe('Plan');
    expect(app.exists('Kanban 1')).toBe(false);
    expect(app.exists(card.replace(/^Kanban 1\//, 'Plan/'))).toBe(true);
    expect(boardNameOnDisk(app, 'Plan/Plan.board.json')).toBe('Plan');
    expect(boardFolder(app)).toBe('Plan');
    expect(errorToasts()).toEqual([]);
  });

  it('a folder the user renamed keeps its name when the board is renamed', async () => {
    const app = await kanbanWithFolders();
    await renameInSidebar(app, 'Kanban 1', 'Mine');
    await waitFor(() => app.exists('Mine/Kanban 1.board.json'), 'the folder renamed');
    await renameActiveBoard(app, 'Plan');
    await waitFor(() => app.exists('Mine/Plan.board.json'), 'the board file renamed in place');
    await quiesce(1500);

    expect(app.exists('Plan')).toBe(false);
    expect(activeTabName(app)).toBe('Plan');
    expect(boardFolder(app)).toBe('Mine');
    expect(errorToasts()).toEqual([]);
  });

  it('renaming the .board.json in the sidebar renames the board', async () => {
    const app = await kanbanWithFolders();
    await renameInSidebar(app, 'Kanban 1/Kanban 1.board.json', 'Roadmap');
    await waitFor(() => activeTabName(app) === 'Roadmap', 'the tab to follow the file');
    await quiesce(1500);

    expect(app.exists('Kanban 1/Roadmap.board.json')).toBe(true);
    expect(boardNameOnDisk(app, 'Kanban 1/Roadmap.board.json')).toBe('Roadmap');
    expect(errorToasts()).toEqual([]);
  });

  it('switched off, new files go to the Root Directory, or the vault root when none is set', async () => {
    const app = await kanbanWithFolders({ 'Notes/n.md': 'N\n' });
    await setBoardFolders(app, false);
    const atRoot = await addKanbanCard(app);
    expect(atRoot.includes('/')).toBe(false);

    await toggleRootDirectory(app, 'Notes');
    const inRoot = await addKanbanCard(app);
    expect(inRoot.startsWith('Notes/')).toBe(true);
    expect(errorToasts()).toEqual([]);
  });

  it('a board made before they were switched on keeps using the Root Directory', async () => {
    const app = await startApp({ 'Notes/n.md': 'N\n' });
    await setBoardFolders(app, false);
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await toggleRootDirectory(app, 'Notes');
    await setBoardFolders(app, true);
    // The sidebar marks where its files go.
    expect(boardFolder(app)).toBe('Notes');
    const card = await addKanbanCard(app);
    expect(card.startsWith('Notes/')).toBe(true);
    expect(errorToasts()).toEqual([]);
  });

  it("a new board doesn't move into a folder left behind with its name", async () => {
    const app = await kanbanWithFolders({ 'Kanban 1/Old card.md': 'Old\n' });
    expect(activeTabName(app)).toBe('Kanban 2');
    expect(boardFolder(app)).toBe('Kanban 2');
    expect(app.exists('Kanban 2/Kanban 2.board.json')).toBe(true);
    expect(app.exists('Kanban 1/Kanban 1.board.json')).toBe(false);
  });

  it("renaming a board to another board's name is refused, though each is alone in its folder", async () => {
    const app = await kanbanWithFolders();
    await createBoard(app, 'kanban');
    expect(activeTabName(app)).toBe('Kanban 2');
    const message = await activeBoardRenameMessage(app, 'Kanban 1');
    expect(message).toBe('A board named "Kanban 1" already exists in "Kanban 1".');
    await quiesce(500);
    expect(activeTabName(app)).toBe('Kanban 2');
    expect(app.exists('Kanban 2/Kanban 2.board.json')).toBe(true);
    expect(app.exists('Kanban 2/Kanban 1.board.json')).toBe(false);
    expect(errorToasts()).toEqual([]);
  });

  it("a new board doesn't take the name of a board elsewhere in the vault", async () => {
    const app = await startApp({ 'Keep.md': 'K\n' });
    await setBoardFolders(app, false);
    await createBoard(app, 'kanban');
    await setBoardFolders(app, true);
    await createBoard(app, 'kanban');
    expect(activeTabName(app)).toBe('Kanban 2');
    expect(app.exists('Kanban 2/Kanban 2.board.json')).toBe(true);
  });
});

// Boards at the top of the vault, as board-specific folders off keeps them.
describe("a board's name is its file name", () => {
  it('a name the file system refuses is shown inline and not applied', async () => {
    const app = await startApp({ 'Keep.md': 'K\n' });
    await setBoardFolders(app, false);
    await createBoard(app, 'kanban');
    const message = await activeBoardRenameMessage(app, 'Q3: plan');
    expect(message).toContain(':');
    expect(activeTabName(app)).toBe('Kanban 1');
    expect(app.exists('Kanban 1.board.json')).toBe(true);
  });

  it("another board's name in the same folder is refused, and neither file changes", async () => {
    const app = await startApp({ 'Keep.md': 'K\n' });
    await setBoardFolders(app, false);
    await createBoard(app, 'kanban');
    await createBoard(app, 'kanban');
    expect(activeTabName(app)).toBe('Kanban 2');
    const message = await activeBoardRenameMessage(app, 'Kanban 1');
    expect(message).toContain('already exists');
    await quiesce(500);
    expect(activeTabName(app)).toBe('Kanban 2');
    expect(boardNameOnDisk(app, 'Kanban 1.board.json')).toBe('Kanban 1');
    expect(app.exists('Kanban 2.board.json')).toBe(true);
  });
});
