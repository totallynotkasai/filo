/**
 * Characterisation — editing a note and seeing it in every view.
 *
 * Pins what the user sees, not how the app does it. Phases 3–6 of the master
 * plan must keep these green without editing this file (only the harness
 * adapter may change).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor } from './harness/app';
import {
  createBoard,
  addMindMapTextTile,
  addKanbanColumn,
  openNoteFromSidebar,
  splitActiveTabRight,
  placeNoteOnBoard,
  editors,
  typeAtEnd,
  kanbanCards,
  taskRows,
  mindMapTiles,
  showBoard,
  $$,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const GROCERIES =
  '---\ntitle: Groceries\ntags:\n  - shop\n  - home\npriority: high\ndueDate: 2026-10-01\n---\nMilk and eggs\n';

describe('editing a note', () => {
  it('typing in a new mind-map tile saves the text to its note', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const note = await addMindMapTextTile(app);
    const [ed] = editors($$(app.el, '.mindmap-board')[0]);
    await typeAtEnd(ed, 'Typed in a tile');
    await quiesce();
    expect(app.read(note)).toContain('Typed in a tile');
  });

  it('typing in a Document tab saves to the file, and a tile of the same note shows it', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\n---\nFirst line\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Plan.md');
    expect(mindMapTiles(app).map((t) => t.text)).toEqual(['First line']);

    await openNoteFromSidebar(app, 'Plan.md');
    const [docEditor] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(docEditor, ' and more');
    await quiesce();
    expect(app.read('Plan.md')).toBe('---\ntitle: Plan\n---\nFirst line and more\n');

    // Back on the board, the tile shows the edit.
    await showBoard(app, 'mindmap');
    await waitFor(() => mindMapTiles(app)[0]?.text === 'First line and more', 'tile to show the edit');
  });

  it('split panes show the same note, and an edit in one appears in the other', async () => {
    const app = await startApp({ 'Shared.md': '---\ntitle: Shared\n---\nOne\n' });
    await openNoteFromSidebar(app, 'Shared.md');
    await splitActiveTabRight(app);
    const panes = $$(app.el, '.pane-view');
    expect(panes).toHaveLength(2);
    const [left] = editors(panes[0]);
    const [right] = editors(panes[1]);
    expect(left.getText()).toBe('One');
    expect(right.getText()).toBe('One');

    await typeAtEnd(left, ' two');
    await quiesce();
    await waitFor(() => right.getText() === 'One two', 'the other pane to follow');
    expect(app.read('Shared.md')).toBe('---\ntitle: Shared\n---\nOne two\n');
  });
});

describe('what the boards show for a note', () => {
  it('a Kanban card shows the note title, tags, due date and priority', async () => {
    const app = await startApp({ 'Groceries.md': GROCERIES });
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await placeNoteOnBoard(app, 'kanban', 'Groceries.md');
    const cards = kanbanCards(app);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Groceries');
    expect(cards[0].tags.sort()).toEqual(['home', 'shop']);
    expect(cards[0].due).toMatch(/1 Oct|Oct 1/);
    expect(cards[0].priority).toBe('High');
  });

  it('a Task List row shows the note title, due date and priority', async () => {
    const app = await startApp({ 'Groceries.md': GROCERIES });
    await createBoard(app, 'tasklist');
    await placeNoteOnBoard(app, 'tasklist', 'Groceries.md');
    const rows = taskRows(app);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Groceries');
    expect(rows[0].due).toMatch(/1 Oct|Oct 1/);
    expect(rows[0].priority).toMatch(/high/i);
    expect(rows[0].completed).toBe(false);
  });
});
