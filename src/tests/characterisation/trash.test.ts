/**
 * Characterisation — deletes go to Filo's trash, and undo moves files back.
 *
 * A sidebar delete moves the file or folder into `.filo/trash`; Ctrl+Z moves
 * it back, with every tile that showed it, whatever its type or size. Settings
 * → Trash restores things that no undo covers. Undo of "Rename file to match
 * title" is the reverse rename.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startApp, stopApp, waitFor, reopenVault } from './harness/app';
import {
  createBoard,
  placeNoteOnBoard,
  dragFromSidebar,
  deleteInSidebar,
  trashedPaths,
  undo,
  openTrashSettings,
  restoreFromTrashSettings,
  closeModal,
  mindMapTiles,
  showBoard,
  renameFileToMatchTitle,
  chooseToastAction,
  addKanbanColumn,
  kanbanCards,
  toastTexts,
  undoAvailable,
  boardFilesText,
  $,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('sidebar delete, then undo', () => {
  it('a note on a board: the file goes to the trash, undo brings back the bytes and the tile', async () => {
    const note = '---\ntitle: Plan\n---\nKeep this\r\n';
    const app = await startApp({ 'Plan.md': note });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Plan.md');
    expect(mindMapTiles(app)).toHaveLength(1);

    await deleteInSidebar(app, 'Plan.md');
    expect(app.exists('Plan.md')).toBe(false);
    expect(trashedPaths(app)).toEqual(['Plan.md']);
    expect(mindMapTiles(app)).toHaveLength(0);

    await undo(app);
    await waitFor(() => app.exists('Plan.md'), 'the note back on disk');
    expect(app.read('Plan.md')).toBe(note);
    await waitFor(() => mindMapTiles(app).length === 1, 'the tile back');
    expect(trashedPaths(app)).toEqual([]);
  });

  it('a .docx and a 40 MB video: the bytes come back exactly, and so do their tiles', async () => {
    const docx = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) % 256);
    const video = new Uint8Array(40 * 1024 * 1024);
    for (let i = 0; i < video.length; i += 4093) video[i] = i % 251;
    const app = await startApp({ 'Report.docx': docx, 'media/clip.mp4': video });
    await createBoard(app, 'mindmap');
    const board = $(app.el, '.mindmap-board');
    await dragFromSidebar(app, 'Report.docx', board);
    await dragFromSidebar(app, 'media/clip.mp4', board);
    await waitFor(() => mindMapTiles(app).length === 2, 'two tiles');

    await deleteInSidebar(app, 'Report.docx');
    await deleteInSidebar(app, 'media/clip.mp4');
    expect(app.exists('Report.docx')).toBe(false);
    expect(app.exists('media/clip.mp4')).toBe(false);
    expect(trashedPaths(app)).toEqual(['Report.docx', 'media/clip.mp4']);
    expect(mindMapTiles(app)).toHaveLength(0);

    await undo(app);
    await undo(app);
    await waitFor(() => app.exists('Report.docx') && app.exists('media/clip.mp4'), 'both files back');
    expect(sha(readFileSync(app.abs('Report.docx')))).toBe(sha(docx));
    expect(sha(readFileSync(app.abs('media/clip.mp4')))).toBe(sha(video));
    await waitFor(() => mindMapTiles(app).length === 2, 'both tiles back');
  });

  it('a folder: everything inside goes to the trash as one item and comes back together', async () => {
    const a = '---\ntitle: A\n---\nAlpha\n';
    const b = '---\ntitle: B\n---\nBeta\n';
    const app = await startApp({ 'Projects/A.md': a, 'Projects/deep/B.md': b, 'Other.md': 'stays\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Projects/A.md');
    await placeNoteOnBoard(app, 'mindmap', 'Projects/deep/B.md');
    await waitFor(() => mindMapTiles(app).length === 2, 'two tiles');

    await deleteInSidebar(app, 'Projects');
    expect(app.userFiles()).toEqual(['Other.md', ...app.userFiles().filter((f) => f.endsWith('.board.json'))].sort());
    expect(trashedPaths(app)).toEqual(['Projects']);
    expect(mindMapTiles(app)).toHaveLength(0);

    await undo(app);
    await waitFor(() => app.exists('Projects/deep/B.md'), 'the folder back');
    expect(app.read('Projects/A.md')).toBe(a);
    expect(app.read('Projects/deep/B.md')).toBe(b);
    await waitFor(() => mindMapTiles(app).length === 2, 'both tiles back');
  });

  it('a board file: it goes to the trash and undo brings it back', async () => {
    const app = await startApp({ 'Idea.md': '---\ntitle: Idea\n---\nText\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Idea.md');
    await createBoard(app, 'kanban');
    await showBoard(app, 'kanban');
    const boardFile = app.userFiles().find((f) => f.endsWith('.board.json') && readFileSync(app.abs(f), 'utf-8').includes('"mindmap"'));
    if (!boardFile) throw new Error('no mind map board file');
    const bytes = app.read(boardFile);

    await deleteInSidebar(app, boardFile);
    expect(app.exists(boardFile)).toBe(false);
    expect(trashedPaths(app)).toEqual([boardFile]);

    await undo(app);
    await waitFor(() => app.exists(boardFile), 'the board file back');
    expect(app.read(boardFile)).toBe(bytes);
  });

  it('after the vault is closed and opened again, undo restores nothing; the item stays in the trash', async () => {
    const app = await startApp({ 'Gone.md': 'bye\n' });
    await createBoard(app, 'mindmap');
    await deleteInSidebar(app, 'Gone.md');
    expect(trashedPaths(app)).toEqual(['Gone.md']);

    await reopenVault(app);
    await undo(app);
    expect(app.exists('Gone.md')).toBe(false);
    expect(trashedPaths(app)).toEqual(['Gone.md']);
  });
});

describe('a delete no board undo holds', () => {
  it("with no board open, the toast's Undo brings the file back", async () => {
    const app = await startApp({ 'Solo.md': 'on its own\n' });
    await deleteInSidebar(app, 'Solo.md');
    expect(trashedPaths(app)).toEqual(['Solo.md']);

    await chooseToastAction('Undo');
    await waitFor(() => app.exists('Solo.md'), 'the note back');
    expect(app.read('Solo.md')).toBe('on its own\n');
    expect(trashedPaths(app)).toEqual([]);
  });
});

describe('Settings → Trash', () => {
  it('restores a deleted note that is on no board', async () => {
    const app = await startApp({ 'Loose.md': 'loose words\n' });
    await deleteInSidebar(app, 'Loose.md');
    expect(app.exists('Loose.md')).toBe(false);

    await openTrashSettings(app);
    await restoreFromTrashSettings('Loose.md');
    await closeModal();
    expect(app.read('Loose.md')).toBe('loose words\n');
    expect(trashedPaths(app)).toEqual([]);
  });

  it('restores beside a new file that took the name, touching neither', async () => {
    const app = await startApp({ 'Draft.md': 'first draft\n' });
    await deleteInSidebar(app, 'Draft.md');
    app.writeExternally('Draft.md', 'second draft\n');

    await openTrashSettings(app);
    await restoreFromTrashSettings('Draft.md');
    await closeModal();
    expect(app.read('Draft.md')).toBe('second draft\n');
    expect(app.read('Draft (restored).md')).toBe('first draft\n');
  });
});

describe('undo of "Rename file to match title"', () => {
  it('puts the old file name back, with the same bytes, and the tile follows', async () => {
    const note = '---\ntitle: Shopping list\n---\nMilk\n';
    const app = await startApp({ 'Untitled.md': note });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Untitled.md');
    await renameFileToMatchTitle(app, 'Untitled.md');
    await waitFor(() => app.exists('Shopping list.md'), 'the renamed file');
    expect(app.exists('Untitled.md')).toBe(false);

    await undo(app);
    await waitFor(() => app.exists('Untitled.md'), 'the old name back');
    expect(app.exists('Shopping list.md')).toBe(false);
    expect(app.read('Untitled.md')).toBe(note);
    await waitFor(() => mindMapTiles(app)[0]?.text === 'Milk', 'the tile still showing the note');
  });
});

describe('a sidebar delete of a note shown on another board than the active one', () => {
  async function cardOnKanbanWithMindMapActive(): Promise<Awaited<ReturnType<typeof startApp>>> {
    const app = await startApp({ 'Card.md': '---\ntitle: Card\n---\nBody\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Card.md');
    expect(kanbanCards(app)).toHaveLength(1);
    await createBoard(app, 'mindmap');
    await deleteInSidebar(app, 'Card.md');
    expect(app.exists('Card.md')).toBe(false);
    return app;
  }

  const cardPlaced = (app: Awaited<ReturnType<typeof startApp>>): boolean =>
    boardFilesText(app).some((text) => text.includes('Card.md'));

  it("the toast offers Undo, and it brings back the note and the card", async () => {
    const app = await cardOnKanbanWithMindMapActive();
    expect(toastTexts()).toContain(`"Card.md" was moved to Filo's trash.`);

    await chooseToastAction('Undo');
    await waitFor(() => app.exists('Card.md'), 'the note back');
    await waitFor(() => cardPlaced(app), 'the card back in the Kanban file');
    // The step left the Mind Map's stack with it: nothing is left to undo there.
    expect(undoAvailable(app)).toBe(false);
    await showBoard(app, 'kanban');
    await waitFor(() => kanbanCards(app).length === 1, 'the card on screen');
  });

  it('Ctrl+Z on the board that was active undoes it; the toast then finds it back already', async () => {
    const app = await cardOnKanbanWithMindMapActive();
    await undo(app);
    await waitFor(() => app.exists('Card.md'), 'the note back');
    await waitFor(() => cardPlaced(app), 'the card back');

    await chooseToastAction('Undo');
    expect(toastTexts()).toContain('"Card.md" is already back.');
    expect(trashedPaths(app)).toEqual([]);
  });

  it('Settings → Trash restores the note and the card, while the delete is in the undo history', async () => {
    const app = await cardOnKanbanWithMindMapActive();

    await openTrashSettings(app);
    await restoreFromTrashSettings('Card.md');
    await closeModal();
    await waitFor(() => app.exists('Card.md'), 'the note back');
    await waitFor(() => cardPlaced(app), 'the card back');
    expect(app.read('Card.md')).toBe('---\ntitle: Card\n---\nBody\n');
    expect(trashedPaths(app)).toEqual([]);
    expect(undoAvailable(app)).toBe(false);
  });
});
