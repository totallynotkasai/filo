/**
 * Characterisation — templates and boards.
 *
 * A layout template's insert is one undo step that takes its new notes with
 * it. A board template starts from any board or the New Tab menu, with its
 * settings, whatever its title holds. A tile, card or task deleted with its
 * file comes back with it from Settings → Trash, and a deleted note follows
 * its board's folder when the board is renamed. Undoing a new card keeps its
 * note once it carries something the user set in another view.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, type CharApp } from './harness/app';
import {
  activeTabKind,
  addKanbanCard,
  addKanbanColumn,
  addMindMapTextTile,
  answerConfirm,
  chooseMenuItem,
  closeModal,
  createBoard,
  deleteTileAndFile,
  errorToasts,
  kanbanCards,
  mindMapTiles,
  openNoteFromSidebar,
  openTrashSettings,
  redo,
  restoreFromTrashSettings,
  rightClick,
  showBoard,
  toastTexts,
  trashedPaths,
  typeInTagRow,
  undo,
} from './harness/actions';
import { cardByTitle } from './harness/listKeys';
import {
  insertLayoutTemplate,
  kanbanCardTemplates,
  kanbanColumnTitles,
  openNewBoardFromTemplate,
  openTemplateBrowser,
  pickTemplate,
  saveLayoutTemplate,
  templateBrowserShows,
} from './harness/templates';
import { renameActiveBoard } from './harness/vaultFolders';

afterEach(async () => {
  await stopApp();
});

/** The notes in the vault that `before` didn't list. */
function newNotes(app: CharApp, before: string[]): string[] {
  const had = new Set(before);
  return app.userFiles().filter((f) => f.endsWith('.md') && !had.has(f));
}

/** The one Mind Map board file, parsed. */
function mindMapFile(app: CharApp): { tileDefs: Record<string, { filePath?: string }>; connections: Record<string, unknown> } {
  const rel = app.userFiles().find((f) => f.endsWith('.board.json') && app.read(f).includes('"mindmap"'));
  if (!rel) throw new Error('no Mind Map board file');
  return JSON.parse(app.read(rel)) as { tileDefs: Record<string, { filePath?: string }>; connections: Record<string, unknown> };
}

describe('a layout template', () => {
  it('inserted and undone takes its new notes to the trash; redo brings back the notes, the tiles and the connection', async () => {
    const app = await startApp({ 'Book.md': 'Text\n' });
    await createBoard(app, 'mindmap');
    saveLayoutTemplate(app, 'Pair', [{ x: 0, y: 0 }, { x: 320, y: 0 }], [[0, 1]]);
    const before = app.userFiles();

    await insertLayoutTemplate('Pair');
    await waitFor(() => newNotes(app, before).length === 2, 'two new notes');
    await waitFor(() => Object.keys(mindMapFile(app).connections).length === 1, 'the connection saved');
    const made = newNotes(app, before).sort();
    expect(mindMapTiles(app)).toHaveLength(2);

    await undo(app);
    await waitFor(() => made.every((rel) => !app.exists(rel)), 'the new notes gone');
    expect(mindMapTiles(app)).toHaveLength(0);
    expect(trashedPaths(app)).toEqual(made);
    expect(errorToasts()).toEqual([]);

    await redo(app);
    await waitFor(() => made.every((rel) => app.exists(rel)), 'the notes back');
    await waitFor(() => mindMapTiles(app).length === 2, 'the tiles back');
    await waitFor(() => Object.keys(mindMapFile(app).connections).length === 1, 'the connection back');
    expect(trashedPaths(app)).toEqual([]);
    expect(newNotes(app, before).sort()).toEqual(made);
  });

  it('tiles that shared a note when it was saved share one new note, and its undo takes that note once', async () => {
    const app = await startApp({ 'Book.md': 'Text\n' });
    await createBoard(app, 'mindmap');
    saveLayoutTemplate(app, 'Twins', [{ x: 0, y: 0, shared: 'g0' }, { x: 320, y: 0, shared: 'g0' }]);
    const before = app.userFiles();

    await insertLayoutTemplate('Twins');
    await waitFor(() => newNotes(app, before).length === 1 && mindMapTiles(app).length === 2, 'one note, two tiles');
    await quiesce(600);
    const [note] = newNotes(app, before);
    const shown = Object.values(mindMapFile(app).tileDefs).map((d) => d.filePath);
    expect(shown).toEqual([note, note]);

    await undo(app);
    await waitFor(() => !app.exists(note!), 'the note gone');
    expect(trashedPaths(app)).toEqual([note]);
    expect(errorToasts()).toEqual([]);
  });
});

describe('a board template', () => {
  const sprint =
    '---\ntitle: "Sprint: Q4?"\n---\nGoals.\n\n```filo-board\n' +
    '{"type":"kanban","settings":{"accentColor":"#ff0000","backgroundPattern":"dots","defaultFolder":"Elsewhere","nonsense":1},' +
    '"columns":[{"title":"To do","cards":["Outline"]},{"title":"Done"}]}\n```\n';

  it("made from a Kanban tab with Ctrl+T: a title a file can't have, its settings, and its skeleton", async () => {
    const app = await startApp({ 'Templates/Sprint.md': sprint, 'Templates/Note.md': '# {{title}}\n' });
    await createBoard(app, 'kanban');

    await openTemplateBrowser();
    expect(templateBrowserShows()).toMatchObject({ sections: ['Board Templates'], rows: ['Sprint: Q4?'], layouts: [] });
    await pickTemplate('Sprint: Q4?');
    await waitFor(() => kanbanColumnTitles(app).join('|') === 'To do|Done', 'the template board');

    const file = app.userFiles().find((f) => f.endsWith('.board.json') && f.includes('Sprint- Q4-'));
    expect(file).toBeDefined();
    const settings = (JSON.parse(app.read(file!)) as { board: { settings: Record<string, unknown> } }).board.settings;
    expect(settings.accentColor).toBe('#ff0000');
    expect(settings.backgroundPattern).toBe('dots');
    expect(settings.nonsense).toBeUndefined();
    expect(settings.defaultFolder).not.toBe('Elsewhere');
    expect(toastTexts().some((t) => t.includes('"defaultFolder", "nonsense"'))).toBe(true);
    expect(errorToasts()).toEqual([]);
  });

  it('New Tab → New board from template… lists only the board templates, even over a Mind Map', async () => {
    const app = await startApp({ 'Templates/Sprint.md': sprint, 'Templates/Note.md': '# {{title}}\n' });
    await createBoard(app, 'mindmap');
    saveLayoutTemplate(app, 'Pair', [{ x: 0, y: 0 }, { x: 320, y: 0 }]);

    await openTemplateBrowser();
    expect(templateBrowserShows()).toMatchObject({
      sections: ['Layout Templates', 'Markdown Templates'],
      rows: ['Note', 'Sprint: Q4?'],
      boardRows: ['Sprint: Q4?'],
      layouts: ['Pair'],
    });
    await closeModal();

    await openNewBoardFromTemplate(app);
    expect(templateBrowserShows()).toMatchObject({ sections: ['Board Templates'], rows: ['Sprint: Q4?'], layouts: [] });
    await pickTemplate('Sprint: Q4?');
    await waitFor(() => kanbanColumnTitles(app).length === 2, 'the template board');
  });

  it("a template whose filo-board block isn't valid JSON is never a card, and makes no board", async () => {
    const app = await startApp({
      'Templates/Broken.md': '```filo-board\n{"type":"kanban", columns: []}\n```\n',
      'Templates/Meeting.md': 'Agenda\n',
    });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    expect(await kanbanCardTemplates(app, 0)).toEqual(['Meeting']);

    await openTemplateBrowser();
    expect(templateBrowserShows().rows).toEqual(['Broken']);
    const boards = app.userFiles().filter((f) => f.endsWith('.board.json'));
    await pickTemplate('Broken', { refused: true });
    expect(toastTexts().some((t) => t.includes(`isn't valid JSON, so no board was made`))).toBe(true);
    expect(app.userFiles().filter((f) => f.endsWith('.board.json'))).toEqual(boards);
    await closeModal();
  });
});

describe('Delete tile and file, then Settings → Trash', () => {
  it('restoring the note brings its tile back', async () => {
    const app = await startApp({ 'Elves.md': '---\ntitle: Elves\n---\nThe elves\n' });
    await createBoard(app, 'mindmap');
    await addMindMapTextTile(app, { title: 'Hero' });
    await quiesce(800);
    const hero = app.userFiles().find((f) => f.endsWith('/Hero.md'))!;

    await deleteTileAndFile(app, mindMapTiles(app)[0]!.el);
    await waitFor(() => !app.exists(hero), 'the note in the trash');
    expect(mindMapTiles(app)).toHaveLength(0);

    await openTrashSettings(app);
    await restoreFromTrashSettings(hero);
    await closeModal();
    await waitFor(() => app.exists(hero), 'the note back');
    await waitFor(() => mindMapTiles(app).length === 1, 'the tile back');
    expect(Object.values(mindMapFile(app).tileDefs).map((d) => d.filePath)).toEqual([hero]);
    expect(toastTexts()).toContain(`Restored "${hero}" and its tile.`);
    expect(trashedPaths(app)).toEqual([]);
  });

  it("a card's Delete from vault…, restored with another board in front: Filo switches to its board and the card comes back", async () => {
    const app = await startApp({ 'Book.md': 'Text\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const rel = await addKanbanCard(app, 0, { title: 'Siege' });
    await rightClick(cardByTitle(app, 'Siege'));
    await chooseMenuItem(app, 'Delete from vault…');
    await answerConfirm(app, { confirm: true });
    await waitFor(() => !app.exists(rel), 'the note in the trash');
    await createBoard(app, 'mindmap');
    expect(activeTabKind(app)).toBe('mindmap');

    await openTrashSettings(app);
    await restoreFromTrashSettings(rel);
    await closeModal();
    await waitFor(() => app.exists(rel), 'the note back');
    expect(activeTabKind(app)).toBe('kanban');
    await waitFor(() => kanbanCards(app).map((c) => c.title).includes('Siege'), 'the card back');
    expect(trashedPaths(app)).toEqual([]);
    expect(errorToasts()).toEqual([]);
  });

  it('when a new note took the name meanwhile, the tile comes back on the restored note, never the new one', async () => {
    const app = await startApp({ 'Book.md': 'Text\n' });
    await createBoard(app, 'mindmap');
    await addMindMapTextTile(app, { title: 'Elves' });
    await quiesce(800);
    const elves = app.userFiles().find((f) => f.endsWith('/Elves.md'))!;
    const original = app.read(elves);

    await deleteTileAndFile(app, mindMapTiles(app)[0]!.el);
    await waitFor(() => !app.exists(elves), 'the note in the trash');
    app.writeExternally(elves, '---\ntitle: Elves\n---\nA different note\n');
    await quiesce(800);

    await openTrashSettings(app);
    await restoreFromTrashSettings(elves);
    await closeModal();
    const restored = elves.replace(/Elves\.md$/, 'Elves (restored).md');
    await waitFor(() => app.exists(restored), 'the original back beside the new note');
    await waitFor(() => mindMapTiles(app).length === 1, 'the tile back');
    expect(app.read(restored)).toBe(original);
    expect(app.read(elves)).toContain('A different note');
    expect(Object.values(mindMapFile(app).tileDefs).map((d) => d.filePath)).toEqual([restored]);
  });
});

describe('a board renamed after a delete', () => {
  it("Ctrl+Z puts the note back in the board's renamed folder, never a new copy of the old one", async () => {
    const app = await startApp({ 'Book.md': 'Text\n' });
    await createBoard(app, 'mindmap');
    await addMindMapTextTile(app, { title: 'Hero' });
    await addMindMapTextTile(app, { title: 'Villain' });
    await quiesce(800);
    expect(app.exists('Mind Map 1/Hero.md')).toBe(true);

    const hero = mindMapTiles(app).find((t) => t.title === 'Hero')!;
    await deleteTileAndFile(app, hero.el);
    await waitFor(() => !app.exists('Mind Map 1/Hero.md'), 'the note in the trash');
    await renameActiveBoard(app, 'Story');
    await waitFor(() => app.exists('Story/Story.board.json'), 'the renamed board and folder');
    await quiesce(800);

    await undo(app);
    await waitFor(() => app.exists('Story/Hero.md'), 'the note back in Story');
    await waitFor(() => mindMapTiles(app).length === 2, 'the tile back');
    expect(app.exists('Mind Map 1')).toBe(false);
    expect(Object.values(mindMapFile(app).tileDefs).map((d) => d.filePath).sort()).toEqual(['Story/Hero.md', 'Story/Villain.md']);
    expect(errorToasts()).toEqual([]);
  });
});

describe('undoing a new card', () => {
  it('keeps its note when a tag was set on it in its Document tab', async () => {
    const app = await startApp({ 'Book.md': 'Text\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const card = await addKanbanCard(app, 0);
    await openNoteFromSidebar(app, card);
    await typeInTagRow(app, 'plot');
    await waitFor(() => /tags:/.test(app.read(card)), 'the tag on disk');

    await showBoard(app, 'kanban');
    await undo(app);
    await waitFor(() => kanbanCards(app).length === 0, 'the card gone');
    await quiesce(600);
    expect(app.exists(card)).toBe(true);
    expect(app.read(card)).toContain('plot');
    expect(trashedPaths(app)).toEqual([]);
  });

  it('still takes an untouched new card\'s note to the trash', async () => {
    const app = await startApp({ 'Book.md': 'Text\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const card = await addKanbanCard(app, 0);

    await undo(app);
    await waitFor(() => !app.exists(card), 'the note gone');
    expect(trashedPaths(app)).toEqual([card]);
  });
});
