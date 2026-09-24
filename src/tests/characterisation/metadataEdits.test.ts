/**
 * Characterisation — metadata edits land in the note's frontmatter, and every
 * board showing the note follows.
 *
 * Pins what the user sees, not how the app does it. Phases 3–6 of the master
 * plan must keep these green without editing this file (only the harness
 * adapter may change).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseDocument } from 'yaml';
import { startApp, stopApp, waitFor, quiesce, type CharApp } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  addKanbanCard,
  quickAddTask,
  placeNoteOnBoard,
  kanbanCards,
  taskRows,
  mindMapTiles,
  setCardDueDate,
  setCardPriority,
  addTag,
  toggleTask,
  showBoard,
  renameTileTitle,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

/** The note's frontmatter as data (the `yaml` package, as the app reads it). */
function frontmatter(app: CharApp, rel: string): Record<string, unknown> {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(app.read(rel));
  if (!m) return {};
  return (parseDocument(m[1]).toJS() ?? {}) as Record<string, unknown>;
}

function body(app: CharApp, rel: string): string {
  return app.read(rel).replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

describe('Task List', () => {
  it('ticking a task writes completed: true to its note and keeps the rest', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const note = await quickAddTask(app, 'Buy milk !!high #shop');
    expect(frontmatter(app, note)).toMatchObject({ completed: false, priority: 'high', tags: ['shop'] });

    await toggleTask(taskRows(app)[0].el);
    expect(frontmatter(app, note)).toMatchObject({ completed: true, priority: 'high', tags: ['shop'] });
    expect(taskRows(app)[0].completed).toBe(true);

    await toggleTask(taskRows(app)[0].el);
    expect(frontmatter(app, note).completed).toBe(false);
  });

  it('ticking a task keeps the note body and unknown keys byte-for-byte', async () => {
    const note = '---\ntitle: Water plants\ncompleted: false\ncustom: "keep me"  # a comment\n---\nThe ferns first.\n';
    const app = await startApp({ 'Water plants.md': note });
    await createBoard(app, 'tasklist');
    await placeNoteOnBoard(app, 'tasklist', 'Water plants.md');
    await toggleTask(taskRows(app)[0].el);
    expect(app.read('Water plants.md')).toBe(note.replace('completed: false', 'completed: true'));
  });
});

describe('Kanban', () => {
  it('setting a due date and a priority on a card writes them to its note', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const note = await addKanbanCard(app);

    await setCardDueDate(kanbanCards(app)[0].el, '2026-11-05');
    await setCardPriority(app, kanbanCards(app)[0].el, 'High');

    const fm = frontmatter(app, note);
    expect(String(fm.dueDate)).toBe('2026-11-05');
    expect(fm.priority).toBe('high');
    expect(kanbanCards(app)[0].priority).toBe('High');
    expect(kanbanCards(app)[0].due).toMatch(/5 Nov|Nov 5/);
  });

  it('editing a card title shows the new title and keeps the note text on every board', async () => {
    const app = await startApp({ 'Errand.md': '---\ntitle: Errand\n---\nPost office, then bank\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Errand.md');
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Errand.md');

    await renameTileTitle(kanbanCards(app)[0].el, 'Weekly errand');
    expect(kanbanCards(app)[0].title).toBe('Weekly errand');
    // Expected change in Phase 3 (D1, D1a): the title goes to frontmatter
    // `title:` and the file keeps its name. Until then a title edit renames
    // the file to match. Phase 3 also adds: the other board's tile shows the
    // new title (today each board keeps its own copy, so it doesn't).
    await waitFor(() => app.exists('Weekly errand.md'), 'the note under its new name');
    expect(app.exists('Errand.md')).toBe(false);
    expect(body(app, 'Weekly errand.md')).toBe('Post office, then bank\n');

    await showBoard(app, 'mindmap');
    await quiesce();
    expect(mindMapTiles(app).map((t) => t.text)).toEqual(['Post office, then bank']);
  });

  it('tagging a card writes the tag to its note, and a second board showing the note shows it', async () => {
    const app = await startApp({ 'Trip.md': '---\ntitle: Trip\n---\nPack bags\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Trip.md');
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Trip.md');

    await addTag(app, kanbanCards(app)[0].el, 'travel');
    expect(frontmatter(app, 'Trip.md').tags).toEqual(['travel']);
    expect(body(app, 'Trip.md')).toBe('Pack bags\n');
    expect(kanbanCards(app)[0].tags).toEqual(['travel']);

    await showBoard(app, 'mindmap');
    await waitFor(() => mindMapTiles(app)[0]?.tags.includes('travel'), 'the mind-map tile to show the tag');
  });
});
