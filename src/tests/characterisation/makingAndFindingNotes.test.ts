/**
 * Characterisation — making and finding notes.
 *
 * - A note or a folder is made from the vault sidebar, with no board: New
 *   note and New folder on a folder's menu and on the empty space below the
 *   files; Ctrl+N in a Document tab; New Tab → Document. A new note opens in
 *   a Document tab with its title ready to type.
 * - A note Filo made under a placeholder name ("New Card.md", "New Tile.md",
 *   "Untitled.md") takes its first title as its file name too, in the same
 *   undo step. A note with a name of its own keeps it.
 * - The sidebar's search finds a note by its title as well as its file name.
 * - Undoing a new tile, card or task whose note is still empty moves that
 *   note to Filo's trash; redo brings it back. A note with text stays.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, type CharApp } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  addKanbanCard,
  addMindMapTextTile,
  quickAddTask,
  addSubtask,
  kanbanCards,
  mindMapTiles,
  taskRows,
  renameTileTitle,
  openNoteFromSidebar,
  activeTabName,
  boardFilesText,
  typeSidebarSearch,
  sidebarListing,
  trashedPaths,
  editors,
  typeAtEnd,
  leaveEditor,
  undo,
  redo,
  errorToasts,
  shortcutsListed,
  openTitleEditor,
  clickEmptyCanvas,
  pressShortcut,
  kanbanColumns,
  showBoard,
} from './harness/actions';
import { pickCardCover } from './harness/pickers';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertMarkdownTemplate, addKanbanCardFromTemplate, kanbanColumnTitles, taskSectionTitles } from './harness/templates';
import { focusBoard, pressAtFocus } from './harness/typingFocus';
import { rebindInHelp, savedHotkeys, focusSidebarRow, selectTile, selectedTileTitles, connectionModeOn, confirmOpen, tilesApart } from './harness/mindMapKeys';
import {
  newNoteFromSidebar,
  newFolderFromSidebar,
  newNoteWithCtrlN,
  newDocumentFromNewTab,
  newTabOptions,
  sidebarMenuLabels,
  renameTaskTitle,
} from './harness/makingNotes';

afterEach(async () => {
  await stopApp();
});

function titleOf(app: CharApp, rel: string): string | undefined {
  return /^title: (.*)$/m.exec(app.read(rel))?.[1];
}

describe('making a note or a folder with no board', () => {
  it('a folder, a folder inside it and a note in that, all from the sidebar', async () => {
    const app = await startApp({ 'Manuscript.md': '# Draft\n' });
    await newFolderFromSidebar(app, null, 'Book');
    await newFolderFromSidebar(app, 'Book', 'Part 1');
    const rel = await newNoteFromSidebar(app, 'Book/Part 1', 'Chapter 4');

    expect(rel).toBe('Book/Part 1/Chapter 4.md');
    expect(titleOf(app, rel)).toBe('Chapter 4');
    expect(activeTabName(app)).toBe('Chapter 4');
    expect(boardFilesText(app)).toEqual([]);
    expect(app.userFiles()).toEqual(['Book/Part 1/Chapter 4.md', 'Manuscript.md']);
    expect(errorToasts()).toEqual([]);
  });

  it('New note on the empty space makes it at the top; Escape keeps "Untitled", and a second takes the next name', async () => {
    const app = await startApp({ 'Book/Chapter 1.md': 'One\n' });
    expect(await sidebarMenuLabels(app, null)).toEqual(['New note', 'New folder']);
    const folderMenu = await sidebarMenuLabels(app, 'Book');
    expect(folderMenu.slice(0, 2)).toEqual(['New note', 'New folder']);
    expect(await sidebarMenuLabels(app, 'Book/Chapter 1.md')).not.toContain('New note');

    expect(await newNoteFromSidebar(app, null, null)).toBe('Untitled.md');
    expect(titleOf(app, 'Untitled.md')).toBe('Untitled');
    expect(await newNoteFromSidebar(app, null, null)).toBe('Untitled (2).md');
  });

  it('Ctrl+N in a Document tab makes a note beside it; New Tab → Document makes one at the top', async () => {
    const app = await startApp({ 'Book/Chapter 1.md': '---\ntitle: Chapter 1\n---\nOne\n' });
    await openNoteFromSidebar(app, 'Book/Chapter 1.md');
    expect(await newNoteWithCtrlN(app, 'Chapter 2')).toBe('Book/Chapter 2.md');
    expect(titleOf(app, 'Book/Chapter 2.md')).toBe('Chapter 2');

    expect(await newTabOptions(app)).toContain('Document');
    expect(await newDocumentFromNewTab(app, 'Ideas')).toBe('Ideas.md');
    expect(activeTabName(app)).toBe('Ideas');
    expect(boardFilesText(app)).toEqual([]);
  });
});

describe('a note under a placeholder name takes its first title as its name', () => {
  it('a Kanban card titled "The Siege" is "The Siege.md"; undo puts back the name and the title, redo both again', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const rel = await addKanbanCard(app, 0, { title: 'The Siege' });

    expect(rel).toBe('Kanban 1/The Siege.md');
    expect(titleOf(app, rel)).toBe('The Siege');
    expect(app.exists('Kanban 1/New Card.md')).toBe(false);
    expect(kanbanCards(app).map((c) => c.title)).toEqual(['The Siege']);

    await undo(app);
    await waitFor(() => app.exists('Kanban 1/New Card.md'), 'the old name back');
    expect(app.exists(rel)).toBe(false);
    expect(titleOf(app, 'Kanban 1/New Card.md')).toBe('New Card');
    expect(kanbanCards(app).map((c) => c.title)).toEqual(['New Card']);

    await redo(app);
    await waitFor(() => app.exists(rel), 'the title name back');
    expect(titleOf(app, rel)).toBe('The Siege');
    expect(errorToasts()).toEqual([]);
  });

  it('a Mind Map tile and a subtask too; a note with a name of its own keeps it', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    expect(await addMindMapTextTile(app, { title: 'Antagonist' })).toBe('Mind Map 1/Antagonist.md');
    // Its name is its own now: a new title leaves it.
    const tile = mindMapTiles(app).find((t) => t.title === 'Antagonist')!;
    await renameTileTitle(tile.el, 'Villain');
    expect(app.exists('Mind Map 1/Antagonist.md')).toBe(true);
    expect(titleOf(app, 'Mind Map 1/Antagonist.md')).toBe('Villain');

    await createBoard(app, 'tasklist');
    const plot = await quickAddTask(app, 'Plot');
    expect(plot).toBe('Task List 1/Plot.md');
    await addSubtask(app, taskRows(app)[0]!.el);
    await waitFor(() => app.exists('Task List 1/Plot - Subtask 1.md'), 'the subtask note');
    const sub = taskRows(app).find((r) => r.title === 'Plot - Subtask 1')!;
    await renameTaskTitle(sub.el, 'Act one');
    await waitFor(() => app.exists('Task List 1/Act one.md'), 'the subtask named by its title');
    expect(app.exists('Task List 1/Plot - Subtask 1.md')).toBe(false);
    expect(titleOf(app, 'Task List 1/Act one.md')).toBe('Act one');
    expect(errorToasts()).toEqual([]);
  });

  it("the sidebar's search finds a note by its title, not only its file name", async () => {
    const app = await startApp({
      'Drafts/ch-07.md': '---\ntitle: The Siege\n---\nThe walls held.\n',
      'Drafts/ch-08.md': '---\ntitle: Aftermath\n---\n',
      'Siege engines.md': 'Trebuchets\n',
    });
    await typeSidebarSearch(app, 'siege');
    expect(sidebarListing(app)).toEqual(['Drafts', 'Drafts/ch-07.md', 'Siege engines.md']);
  });
});

describe('undoing a new tile, card or task whose note is still empty', () => {
  it("moves a Mind Map tile's empty note to Filo's trash, and redo brings it back", async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const rel = await addMindMapTextTile(app);
    expect(app.exists(rel)).toBe(true);

    await undo(app);
    await waitFor(() => !app.exists(rel), 'the empty note gone');
    expect(mindMapTiles(app)).toEqual([]);
    expect(trashedPaths(app)).toEqual([rel]);

    await redo(app);
    await waitFor(() => app.exists(rel), 'the note back');
    await waitFor(() => mindMapTiles(app).length === 1, 'the tile back');
    expect(trashedPaths(app)).toEqual([]);
    expect(errorToasts()).toEqual([]);
  });

  it("does the same for a Kanban card and a quick-added task", async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const card = await addKanbanCard(app);
    await undo(app);
    await waitFor(() => !app.exists(card), 'the card note gone');
    expect(kanbanCards(app)).toEqual([]);

    await createBoard(app, 'tasklist');
    const task = await quickAddTask(app, 'Buy milk');
    await undo(app);
    await waitFor(() => !app.exists(task), 'the task note gone');
    expect(taskRows(app)).toEqual([]);
    expect(trashedPaths(app)).toEqual([card, task].sort());

    await redo(app);
    await waitFor(() => app.exists(task) && taskRows(app).length === 1, 'the task back');
    expect(errorToasts()).toEqual([]);
  });

  it('leaves a note the user wrote in', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const rel = await addMindMapTextTile(app);
    const tile = mindMapTiles(app)[0]!;
    const [ed] = editors(tile.el.querySelector('.tile-body') ?? tile.el);
    await typeAtEnd(ed!, 'The river city is built on stilts.');
    await leaveEditor(ed!);
    await waitFor(() => app.read(rel).includes('stilts'), 'the text saved');

    await undo(app);
    await waitFor(() => mindMapTiles(app).length === 0, 'the tile gone');
    expect(app.exists(rel)).toBe(true);
    expect(trashedPaths(app)).toEqual([]);
  });
});

describe("the Mind Map's single keys are commands, and stay on the canvas", () => {
  it('Help lists N, C, Enter and Backspace; N rebound to M there makes tiles from M, and is saved', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    expect(await shortcutsListed(app)).toEqual(expect.arrayContaining([
      'Mind Map: New tile beside the selection: N',
      'Mind Map: Connect the selected tile: C',
      'Mind Map: Rename the selected tile: Enter',
      'Mind Map: Remove the selected tiles: Backspace',
    ]));

    await rebindInHelp(app, 'Mind Map: New tile beside the selection', 'm');
    await waitFor(() => savedHotkeys(app)['mindmap:new-tile'] === 'M', 'the new binding saved');
    await focusBoard(app, 'mindmap');
    await pressAtFocus('n');
    expect(mindMapTiles(app)).toEqual([]);
    await pressAtFocus('m');
    await waitFor(() => mindMapTiles(app).length === 1, 'a tile from M');
  });

  it('keys typed on a sidebar row leave the Mind Map alone', async () => {
    const app = await startApp({ 'Chapter 1.md': 'One\n', 'Chapter 2.md': 'Two\n' });
    await createBoard(app, 'mindmap');
    await addMindMapTextTile(app, { title: 'Hero' });
    await addMindMapTextTile(app, { title: 'Villain' });
    await selectTile(mindMapTiles(app).find((t) => t.title === 'Hero')!.el);
    expect(selectedTileTitles(app)).toEqual(['Hero']);

    await focusSidebarRow(app, 'Chapter 1.md');
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowLeft', 'Enter', 'Delete', 'Backspace', 'n', 'c']) {
      await focusSidebarRow(app, 'Chapter 1.md');
      await pressAtFocus(key);
    }
    expect(mindMapTiles(app).map((t) => t.title).sort()).toEqual(['Hero', 'Villain']);
    expect(selectedTileTitles(app)).toEqual(['Hero']);
    expect(confirmOpen()).toBe(false);
    expect(connectionModeOn(app)).toBe(false);
    expect(openTitleEditor(app)).toBeNull();

    // On the canvas the same keys act: Delete asks to remove the selected tile.
    await selectTile(mindMapTiles(app).find((t) => t.title === 'Hero')!.el);
    await pressAtFocus('Delete');
    await waitFor(() => confirmOpen(), 'the remove confirm');
  });

  it('a press on the empty canvas gives it the keys; N, Ctrl+N and the side toolbar make tiles clear of the others', async () => {
    const app = await startApp({ 'Chapter 1.md': 'One\n' });
    await createBoard(app, 'mindmap');
    await addMindMapTextTile(app);
    await focusSidebarRow(app, 'Chapter 1.md');
    await clickEmptyCanvas(app);
    await pressAtFocus('n');
    await waitFor(() => mindMapTiles(app).length === 2, 'a second tile');
    await pressAtFocus('Escape');
    await clickEmptyCanvas(app);
    pressShortcut('n', { ctrlKey: true });
    await waitFor(() => mindMapTiles(app).length === 3, 'a tile from Ctrl+N');
    await pressAtFocus('Escape');
    await addMindMapTextTile(app);
    await addMindMapTextTile(app);
    expect(mindMapTiles(app)).toHaveLength(5);
    expect(tilesApart(app)).toBe(true);
  });
});

describe('one template path for every board', () => {
  const character = '---\ntags: [character]\nrole: lead\nage: 34\nmade: "{{date}}"\nboardType: mindmap\n---\n# {{title}}\nBackstory:\n';

  it("a Markdown template on a Mind Map keeps the template's frontmatter, with {{date}} filled in", async () => {
    const app = await startApp({ 'Templates/Character.md': character });
    await createBoard(app, 'mindmap');
    await insertMarkdownTemplate(app, 'Character');
    await waitFor(() => app.exists('Mind Map 1/Character.md'), 'the note from the template');
    const text = app.read('Mind Map 1/Character.md');
    expect(text).toMatch(/^title: Character$/m);
    expect(text).toMatch(/^tags:/m);
    expect(text).toMatch(/^role: lead$/m);
    expect(text).toMatch(/^age: 34$/m);
    expect(text).toMatch(/^made: "?\d{4}-\d{2}-\d{2}"?$/m);
    expect(text).not.toContain('{{');
    expect(text).not.toContain('boardType');
    expect(text).toContain('# Character\nBackstory:');
    expect(mindMapTiles(app).map((t) => t.title)).toEqual(['Character']);
  });

  it('a Kanban card from a template fills in {{date}} in its title and frontmatter', async () => {
    const app = await startApp({ 'Templates/Meeting.md': '---\ntitle: Meeting {{date}}\nheld: "{{date}}"\n---\nAgenda\n' });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanCardFromTemplate(app, 0, 'Meeting');
    const made = app.userFiles().filter((f) => f.startsWith('Kanban 1/Meeting '));
    expect(made).toHaveLength(1);
    const text = app.read(made[0]!);
    expect(text).toMatch(/^title: Meeting \d{4}-\d{2}-\d{2}$/m);
    expect(text).toMatch(/^held: "?\d{4}-\d{2}-\d{2}"?$/m);
    expect(kanbanCards(app).map((c) => c.title)[0]).toMatch(/^Meeting \d{4}-\d{2}-\d{2}$/);
  });

  it("a board template makes the board's columns and cards (or sections and tasks), each with a note", async () => {
    const app = await startApp({
      'Templates/Sprint.md': '---\ntitle: Sprint\n---\nGoals for the sprint.\n\n```filo-board\n{"type":"kanban","columns":[{"title":"To do","cards":["Outline","Draft"]},{"title":"Done"}]}\n```\n',
      'Templates/Week.md': '```filo-board\n{"type":"tasklist","sections":[{"title":"Monday","tasks":["Call the editor"]},{"title":"Friday","tasks":["Send pages",{"title":"Back up","body":"Both drives"}]}]}\n```\n',
    });
    await createBoard(app, 'mindmap');
    await insertMarkdownTemplate(app, 'Sprint');
    await waitFor(() => kanbanColumnTitles(app).length === 2, 'the template board');
    expect(kanbanColumnTitles(app)).toEqual(['To do', 'Done']);
    expect(kanbanColumns(app)).toEqual([['Outline', 'Draft'], []]);
    const outline = app.userFiles().find((f) => f.endsWith('/Outline.md'))!;
    // The template's own text goes into the first card.
    expect(app.read(outline)).toContain('Goals for the sprint.');

    await showBoard(app, 'mindmap');
    await insertMarkdownTemplate(app, 'Week');
    await waitFor(() => taskSectionTitles(app).length === 2, 'the template task list');
    expect(taskSectionTitles(app)).toEqual(['Monday', 'Friday']);
    expect(taskRows(app).map((r) => r.title)).toEqual(['Call the editor', 'Send pages', 'Back up']);
    const backup = app.userFiles().find((f) => f.endsWith('/Back up.md'))!;
    expect(app.read(backup)).toContain('Both drives');
    expect(errorToasts()).toEqual([]);
  });
});

describe('a picked file already in the vault is linked, not copied', () => {
  it("a card's cover picked from the vault is that file; one from outside is copied in", async () => {
    const outside = mkdtempSync(join(tmpdir(), 'filo-char-outside-'));
    writeFileSync(join(outside, 'sunset.png'), 'png-bytes');
    try {
      const app = await startApp({ 'Art/cover.png': 'png-bytes' });
      await createBoard(app, 'kanban');
      await addKanbanColumn(app);
      await addKanbanCard(app, 0, { title: 'Siege' });
      await addKanbanCard(app, 0, { title: 'Escape' });
      const before = app.userFiles();

      await pickCardCover(kanbanCards(app).find((c) => c.title === 'Siege')!.el, app.abs('Art/cover.png'));
      await waitFor(() => boardFilesText(app).some((t) => t.includes('"coverImage": "Art/cover.png"')), 'the cover linked by its path');
      expect(app.userFiles()).toEqual(before);

      await pickCardCover(kanbanCards(app).find((c) => c.title === 'Escape')!.el, join(outside, 'sunset.png'));
      await waitFor(() => app.exists('Kanban 1/sunset.png'), 'the outside picture copied in');
      await waitFor(() => boardFilesText(app).some((t) => t.includes('"coverImage": "Kanban 1/sunset.png"')), 'the copy used as the cover');
      expect(errorToasts()).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
