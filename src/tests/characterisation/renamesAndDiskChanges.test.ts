/**
 * Characterisation — renames, edits made by other programs, deletes and undo,
 * and the vault-wide tag rename.
 *
 * Pins what the user sees, not how the app does it. Phases 3–6 of the master
 * plan must keep these green without editing this file (only the harness
 * adapter may change). Expected change, made in Phase 6 and nowhere else:
 * "delete tile and file" moves the file to `.filo/trash`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, reopenVault } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  addKanbanCard,
  placeNoteOnBoard,
  openNoteFromSidebar,
  renameInSidebar,
  deleteTileAndFile,
  trashedPaths,
  undo,
  renameTagEverywhere,
  kanbanCards,
  mindMapTiles,
  editors,
  typeAtEnd,
  diskConflictPrompt,
  keepMine,
  reloadFromDisk,
  showBoard,
  $$,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

function docEditorText(el: HTMLElement): string {
  return editors($$(el, '.document-board')[0])[0].getText();
}

describe('sidebar rename', () => {
  it('renaming a note keeps its bytes, and the tile follows the new name across a relaunch', async () => {
    const note = '---\ntitle: Old name\n---\nKeep this text\n';
    const app = await startApp({ 'Old name.md': note });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Old name.md');

    await renameInSidebar(app, 'Old name.md', 'New name');
    await waitFor(() => app.exists('New name.md'), 'the renamed file');
    expect(app.exists('Old name.md')).toBe(false);
    expect(app.read('New name.md')).toBe(note);
    expect(mindMapTiles(app).map((t) => t.text)).toEqual(['Keep this text']);

    await reopenVault(app);
    await showBoard(app, 'mindmap');
    await waitFor(() => mindMapTiles(app)[0]?.text === 'Keep this text', 'the tile after relaunch');
    expect(app.exists('Old name.md')).toBe(false);
  });
});

describe('edits made by another program', () => {
  it('while the note is open and unedited, the view follows and the app writes nothing back', async () => {
    const app = await startApp({ 'Log.md': '---\ntitle: Log\n---\nDay one\n' });
    await openNoteFromSidebar(app, 'Log.md');
    await quiesce();

    const external = '---\ntitle: Log\n---\nDay one\n\nDay two\n';
    app.writeExternally('Log.md', external);
    await waitFor(() => docEditorText(app.el).includes('Day two'), 'the editor to show the external edit');
    await quiesce();
    expect(app.read('Log.md')).toBe(external);
    expect(diskConflictPrompt()).toBe(false);
  });

  it('a frontmatter-only change while the note is open keeps the body and shows no prompt', async () => {
    const app = await startApp({ 'Idea.md': '---\ntitle: Idea\n---\nThe body\n' });
    await openNoteFromSidebar(app, 'Idea.md');
    await quiesce();

    const external = '---\ntitle: Idea\nstatus: draft\n---\nThe body\n';
    app.writeExternally('Idea.md', external);
    await quiesce(2500);
    expect(diskConflictPrompt()).toBe(false);
    expect(app.read('Idea.md')).toBe(external);
    expect(docEditorText(app.el)).toBe('The body');
  });

  it('while the note has an unsaved edit, the user is asked; "keep mine" keeps the typed text', async () => {
    const app = await startApp({ 'Draft.md': '---\ntitle: Draft\n---\nStart\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();

    await typeAtEnd(editors($$(app.el, '.document-board')[0])[0], ' mine');
    app.writeExternally('Draft.md', '---\ntitle: Draft\n---\nStart theirs\n');
    await waitFor(() => diskConflictPrompt(), 'the disk-conflict prompt');

    await keepMine();
    await quiesce();
    expect(app.read('Draft.md')).toBe('---\ntitle: Draft\n---\nStart mine\n');
  });

  it('while the note has an unsaved edit, "reload" shows the other program\'s version', async () => {
    const app = await startApp({ 'Draft.md': '---\ntitle: Draft\n---\nStart\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();

    await typeAtEnd(editors($$(app.el, '.document-board')[0])[0], ' mine');
    const theirs = '---\ntitle: Draft\n---\nStart theirs\n';
    app.writeExternally('Draft.md', theirs);
    await waitFor(() => diskConflictPrompt(), 'the disk-conflict prompt');

    await reloadFromDisk();
    await quiesce();
    expect(docEditorText(app.el)).toBe('Start theirs');
    expect(app.read('Draft.md')).toBe(theirs);
  });
});

describe('delete a tile and its file, then undo', () => {
  it('Kanban: the file goes, and undo brings back the card and the same bytes', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const note = await addKanbanCard(app);
    const bytes = app.read(note);
    const title = kanbanCards(app)[0].title;

    await deleteTileAndFile(app, kanbanCards(app)[0].el);
    expect(kanbanCards(app)).toHaveLength(0);
    expect(app.exists(note)).toBe(false);
    expect(trashedPaths(app)).toEqual([note]);

    await undo(app);
    await waitFor(() => kanbanCards(app).length === 1, 'the card to come back');
    expect(kanbanCards(app)[0].title).toBe(title);
    expect(app.read(note)).toBe(bytes);
    expect(trashedPaths(app)).toEqual([]);
  });

  it('Mind map: the file goes, and undo brings back the tile and its text', async () => {
    const note = '---\ntitle: Keep safe\ntags:\n  - vital\n---\nImportant words\n';
    const app = await startApp({ 'Keep safe.md': note });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Keep safe.md');

    await deleteTileAndFile(app, mindMapTiles(app)[0].el);
    expect(mindMapTiles(app)).toHaveLength(0);
    expect(app.exists('Keep safe.md')).toBe(false);
    expect(trashedPaths(app)).toEqual(['Keep safe.md']);

    await undo(app);
    await waitFor(() => mindMapTiles(app).length === 1, 'the tile to come back');
    await waitFor(() => mindMapTiles(app)[0].text === 'Important words', 'the tile text');
    expect(app.read('Keep safe.md')).toBe(note);
  });
});

describe('vault-wide tag rename', () => {
  it('renames the tag in every note and on the board, touching nothing else', async () => {
    const a = '---\ntitle: A\ntags:\n  - old\n  - other\npriority: low # keep\n---\nBody A\n';
    const b = '---\ntitle: B\ntags: [old]\n---\nBody B\n';
    const app = await startApp({ 'A.md': a, 'B.md': b, 'C.md': '---\ntitle: C\n---\nNo tags\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'A.md');

    await renameTagEverywhere(app, 'old', 'fresh');
    await quiesce();
    expect(app.read('A.md')).toBe(a.replace('  - old', '  - fresh'));
    expect(app.read('B.md')).toBe(b.replace('[old]', '[fresh]'));
    expect(app.read('C.md')).toBe('---\ntitle: C\n---\nNo tags\n');
    await waitFor(() => kanbanCards(app)[0]?.tags.includes('fresh'), 'the card to show the new tag');
    expect(kanbanCards(app)[0].tags).not.toContain('old');
  });
});
