/**
 * Characterisation — the note is the only copy of its title and tags.
 *
 * A board file names each note by path and keeps only what is visual. The
 * note's frontmatter `title:` is its title (the filename stem without one),
 * and a title edit never renames the file. Note tags live in frontmatter,
 * media-file tags in `.filo/tags.json`. A board made by an older Filo is
 * refused and left untouched.
 *
 * Pins what the user sees and what is on disk, not how the app does it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseDocument } from 'yaml';
import { startApp, stopApp, waitFor, quiesce, reopenVault, type CharApp } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  quickAddTask,
  addMindMapTextTile,
  editors,
  typeAtEnd,
  placeNoteOnBoard,
  kanbanCards,
  mindMapTiles,
  taskRows,
  renameTileTitle,
  typeTileTitle,
  clickEmptyCanvas,
  renameInSidebar,
  renameFileToMatchTitle,
  sidebarRenameMessage,
  addTag,
  undo,
  openNoteFromSidebar,
  showBoard,
  $$,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

function frontmatter(app: CharApp, rel: string): Record<string, unknown> {
  const text = app.read(rel).replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? ((parseDocument(m[1]).toJS() ?? {}) as Record<string, unknown>) : {};
}

function boardFiles(app: CharApp): string[] {
  return app.userFiles().filter((f) => f.endsWith('.board.json'));
}

function boardJson(app: CharApp, rel: string): { version: number; tileDefs: Record<string, Record<string, unknown>> } {
  return JSON.parse(app.read(rel)) as { version: number; tileDefs: Record<string, Record<string, unknown>> };
}

// A 2×2 PNG, so there is a real image to tag.
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
    'base64',
  ),
);

describe('titles', () => {
  it('a title edit changes only the title: line, keeps CRLF and BOM, and never renames the file', async () => {
    const note = '\uFEFF---\r\ntitle: Old title\r\ntags: [keep]\r\n# a comment\r\n---\r\nBody line\r\n';
    const app = await startApp({ 'Plans.md': note });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Plans.md');
    expect(mindMapTiles(app)[0].title).toBe('Old title');

    await renameTileTitle(mindMapTiles(app)[0].el, 'New title');
    await waitFor(() => app.read('Plans.md').includes('New title'), 'the new title in the note');
    await quiesce();
    expect(app.read('Plans.md')).toBe(note.replace('title: Old title', 'title: New title'));
    expect(app.userFiles().filter((f) => f.endsWith('.md'))).toEqual(['Plans.md']);
    expect(mindMapTiles(app)[0].title).toBe('New title');

    await undo(app);
    await waitFor(() => app.read('Plans.md') === note, 'the old title back');
    expect(mindMapTiles(app)[0].title).toBe('Old title');
  });

  it('a title typed and then clicked away from is saved, with no Enter', async () => {
    const note = '---\ntitle: Old title\n---\nBody line\n';
    const app = await startApp({ 'Plans.md': note });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Plans.md');

    await typeTileTitle(mindMapTiles(app)[0].el, 'Clicked away');
    await clickEmptyCanvas(app);
    await waitFor(() => frontmatter(app, 'Plans.md').title === 'Clicked away', 'the title saved');
    await quiesce();
    expect(app.read('Plans.md')).toBe(note.replace('Old title', 'Clicked away'));
    expect(mindMapTiles(app)[0].title).toBe('Clicked away');
  });

  it('a note without title: shows its filename stem, and a title edit adds the key', async () => {
    const app = await startApp({ 'Plain note.md': 'Just text\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Plain note.md');
    expect(mindMapTiles(app)[0].title).toBe('Plain note');
    await quiesce();
    expect(app.read('Plain note.md')).toBe('Just text\n');

    await renameTileTitle(mindMapTiles(app)[0].el, 'Named');
    await waitFor(() => frontmatter(app, 'Plain note.md').title === 'Named', 'the added title');
    expect(app.exists('Named.md')).toBe(false);
    expect(app.read('Plain note.md').endsWith('Just text\n')).toBe(true);
  });

  it('a sidebar rename leaves the title alone, and the tiles follow the path', async () => {
    const note = '---\ntitle: Alpha\n---\nText\n';
    const app = await startApp({ 'a.md': note });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'a.md');

    await renameInSidebar(app, 'a.md', 'b');
    await waitFor(() => app.exists('b.md'), 'the renamed file');
    expect(app.read('b.md')).toBe(note);
    expect(mindMapTiles(app).map((t) => t.title)).toEqual(['Alpha']);
    expect(mindMapTiles(app).map((t) => t.text)).toEqual(['Text']);
  });

  it('"Rename file to match title" renames the file to the title, and the tiles follow', async () => {
    const note = '---\ntitle: Final Report\n---\nDone\n';
    const app = await startApp({ 'draft-1.md': note });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'draft-1.md');

    await renameFileToMatchTitle(app, 'draft-1.md');
    await waitFor(() => app.exists('Final Report.md'), 'the file under its title');
    expect(app.exists('draft-1.md')).toBe(false);
    expect(app.read('Final Report.md')).toBe(note);
    expect(mindMapTiles(app).map((t) => t.text)).toEqual(['Done']);
  });

  it('the sidebar rename blocks illegal characters with a message instead of changing the name', async () => {
    const app = await startApp({ 'Keep.md': 'x\n' });
    const message = await sidebarRenameMessage(app, 'Keep.md', 'a/b');
    expect(message).toMatch(/"\/"/);
    expect(app.userFiles()).toEqual(['Keep.md']);
  });

  it("a new mind-map tile's note is created with title:, and typing in it keeps it", async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const rel = await addMindMapTextTile(app);
    const title = mindMapTiles(app)[0].title;
    expect(frontmatter(app, rel).title).toBe(title);
    await typeAtEnd(editors(mindMapTiles(app)[0].el)[0], 'Some text');
    await waitFor(() => app.read(rel).includes('Some text'), 'the typed text in the note');
    await quiesce();
    expect(frontmatter(app, rel).title).toBe(title);
  });

  it('a new note titled "What? / Why" is named What- - Why.md and keeps the exact title', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const rel = await quickAddTask(app, 'What? / Why');
    expect(rel).toBe('What- - Why.md');
    expect(frontmatter(app, rel).title).toBe('What? / Why');
    expect(taskRows(app).map((r) => r.title)).toEqual(['What? / Why']);
  });
});

describe('tags', () => {
  it("a card's tag is only in its note, and a second board showing the note shows it", async () => {
    const app = await startApp({ 'Trip.md': '---\ntitle: Trip\n---\nPack\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Trip.md');
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Trip.md');

    await addTag(app, kanbanCards(app)[0].el, 'travel');
    expect(frontmatter(app, 'Trip.md').tags).toEqual(['travel']);
    await quiesce();
    for (const rel of boardFiles(app)) expect(app.read(rel)).not.toContain('travel');
    const tagsFile = app.exists('.filo/tags.json') ? (JSON.parse(app.read('.filo/tags.json')) as { fileTags: Record<string, string[]> }) : { fileTags: {} };
    expect(Object.keys(tagsFile.fileTags).filter((k) => k.toLowerCase().endsWith('.md'))).toEqual([]);
  });

  it("an image's tag is only in .filo/tags.json", async () => {
    const app = await startApp({ 'pic.png': PNG });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'pic.png');
    const image = $$(app.el, '.mindmap-board .tile-container').find((t) => t.querySelector('img'));
    expect(image).toBeDefined();

    await addTag(app, image!, 'media-tag');
    await waitFor(() => app.exists('.filo/tags.json') && app.read('.filo/tags.json').includes('media-tag'), 'the tag in tags.json');
    const tagsFile = JSON.parse(app.read('.filo/tags.json')) as { fileTags: Record<string, string[]> };
    expect(Object.values(tagsFile.fileTags)).toEqual([['media-tag']]);
    await quiesce();
    for (const rel of boardFiles(app)) expect(app.read(rel)).not.toContain('media-tag');
  });
});

describe('board files', () => {
  it('hold no copy of a note title, tags or body, and survive a relaunch unchanged', async () => {
    const app = await startApp({
      'One.md': '---\ntitle: One\ntags: [a]\n---\nFirst\n',
      'Two.md': '---\ntitle: Two\n---\nSecond\n',
    });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'One.md');
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Two.md');
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Three');
    await quiesce();

    const files = boardFiles(app);
    expect(files).toHaveLength(3);
    const allowed = new Set(['id', 'type', 'filePath', 'style', 'titleHtml', 'createdAt', 'updatedAt']);
    for (const rel of files) {
      const data = boardJson(app, rel);
      expect(data.version).toBe(8);
      for (const def of Object.values(data.tileDefs)) {
        if (def.type !== 'text') continue;
        expect(Object.keys(def).filter((k) => !allowed.has(k))).toEqual([]);
        expect(typeof def.filePath).toBe('string');
      }
    }

    const before = new Map(files.map((f) => [f, app.read(f)]));
    await reopenVault(app);
    await quiesce();
    for (const [rel, bytes] of before) expect(app.read(rel)).toBe(bytes);
  });

  it('a board made by an older Filo is refused and never written', async () => {
    const old = JSON.stringify({
      version: 7,
      board: { id: 'b_old', type: 'mindmap', name: 'Old', emoji: '', createdAt: 1, updatedAt: 1, settings: {}, placements: {}, inlineTiles: {}, groups: [], waypoints: [] },
      tileDefs: {},
      connections: {},
      frames: [],
    }, null, 2);
    const app = await startApp({ 'Old.board.json': old, 'Note.md': 'x\n' });
    await quiesce();
    expect(app.el.querySelector('.tab[role="tab"][title*="Old"]')).toBeNull();
    await reopenVault(app);
    await quiesce();
    expect(app.read('Old.board.json')).toBe(old);
  });
});

describe('the path is the note\'s identity', () => {
  it('a note open in a tile and a Document tab keeps saving to its new name after a rename', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\n---\nFirst\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Plan.md');
    await openNoteFromSidebar(app, 'Plan.md');
    const [docEditor] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(docEditor, ' second');
    await quiesce();

    await renameInSidebar(app, 'Plan.md', 'Renamed');
    await waitFor(() => app.exists('Renamed.md'), 'the renamed file');
    await typeAtEnd(docEditor, ' third');
    await quiesce();

    expect(app.exists('Plan.md')).toBe(false);
    expect(app.read('Renamed.md')).toBe('---\ntitle: Plan\n---\nFirst second third\n');
    await showBoard(app, 'mindmap');
    await waitFor(() => mindMapTiles(app)[0]?.text === 'First second third', 'the tile to show every edit');
    expect(mindMapTiles(app)[0].title).toBe('Plan');
  });

  it('renaming the folder above an open note moves it, and later edits land in the moved file', async () => {
    const app = await startApp({ 'Notes/Daily.md': 'Monday\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Notes/Daily.md');
    const [tileEditor] = editors($$(app.el, '.mindmap-board')[0]);

    await renameInSidebar(app, 'Notes', 'Archive');
    await waitFor(() => app.exists('Archive/Daily.md'), 'the moved note');
    await typeAtEnd(tileEditor, ' Tuesday');
    await quiesce();

    expect(app.exists('Notes/Daily.md')).toBe(false);
    // Whether the editor keeps a frontmatter-less note's final newline is not
    // what this pins; where the bytes land is.
    expect(app.read('Archive/Daily.md')).toMatch(/^Monday Tuesday\n?$/);
  });
});
