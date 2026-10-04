/**
 * Characterisation — what typing does right after making a card or a tile,
 * and where the boards' single-letter keys act.
 *
 * A new card or tile opens with its title selected, so typing names it (its
 * note's `title:`), and its empty body says where its text goes. Escape on a
 * title the user has just started keeps what was typed: there is no earlier
 * title to go back to. A board's bare N (and the Mind Map's C, Enter,
 * Backspace) act only while focus is in that board, so typing anywhere else
 * never makes a tile or a card.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  addKanbanCard,
  addMindMapTextTile,
  kanbanCards,
  mindMapTiles,
  openTitleEditor,
  $$,
} from './harness/actions';
import { typeAtFocus, pressAtFocus, focusPage, focusBoard, emptyBodyHint } from './harness/typingFocus';

afterEach(async () => {
  await stopApp();
});

describe('a new card or tile takes what is typed next', () => {
  it('a new Kanban card opens with its title selected: typing names the card and its note', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const before = app.userFiles().length;
    const note = await addKanbanCard(app, 0, { keepOpen: true });

    await typeAtFocus('Outline chapter 3');
    await pressAtFocus('Enter');
    await quiesce();

    expect(kanbanCards(app).map((c) => c.title)).toEqual(['Outline chapter 3']);
    expect(app.read(note)).toContain('title: Outline chapter 3');
    // The space and the N went into the title, not to Add Card or its picker.
    expect(app.userFiles().length).toBe(before + 1);
    expect($$(app.el, 'button.kn-option')).toHaveLength(0);
    // Its empty body says where its text goes.
    expect(emptyBodyHint(kanbanCards(app)[0]!.el)).toBe('Start typing...');
  });

  it('typing a name with N in it into a new Mind Map tile makes no extra tiles', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const before = app.userFiles().length;
    const note = await addMindMapTextTile(app, { keepOpen: true });

    await typeAtFocus('Antagonist');
    await pressAtFocus('Enter');
    await quiesce();

    expect(mindMapTiles(app).map((t) => t.title)).toEqual(['Antagonist']);
    expect(app.read(note)).toContain('title: Antagonist');
    expect(app.userFiles().length).toBe(before + 1);
    expect(emptyBodyHint(mindMapTiles(app)[0]!.el)).toBe('Start typing...');
  });

  it('Escape on a title just started keeps what was typed', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const note = await addMindMapTextTile(app, { keepOpen: true });

    await typeAtFocus('River city');
    await pressAtFocus('Escape');
    await quiesce();

    expect(openTitleEditor(app)).toBeNull();
    expect(mindMapTiles(app).map((t) => t.title)).toEqual(['River city']);
    expect(app.read(note)).toContain('title: River city');
  });

  it('after the title, N makes the next tile from the keyboard', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await addMindMapTextTile(app, { keepOpen: true });
    await typeAtFocus('Magic system');
    await pressAtFocus('Enter');
    await quiesce(600);

    // Enter handed focus to the tile, so the board's keys work on from it.
    await pressAtFocus('n');
    await waitFor(() => mindMapTiles(app).length === 2 && openTitleEditor(app) !== null, 'a second tile, its title open');
    await typeAtFocus('Antagonist');
    await pressAtFocus('Enter');
    await quiesce();
    expect(mindMapTiles(app).map((t) => t.title).sort()).toEqual(['Antagonist', 'Magic system']);
  });
});

describe("a board's single-letter keys act only while it has focus", () => {
  it('Mind Map: N typed while the page has focus makes no tile; on the canvas it does', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const before = app.userFiles().length;

    await focusPage();
    await typeAtFocus('n');
    await quiesce(600);
    expect(mindMapTiles(app)).toHaveLength(0);
    expect(app.userFiles().length).toBe(before);

    await focusBoard(app, 'mindmap');
    await pressAtFocus('n');
    await waitFor(() => mindMapTiles(app).length === 1, 'a tile made by N on the canvas');
  });

  it('Kanban: N typed while the page has focus opens nothing; on the board it opens the new-card picker', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);

    await focusPage();
    await typeAtFocus('n');
    await quiesce(300);
    expect($$(app.el, 'button.kn-option')).toHaveLength(0);

    await focusBoard(app, 'kanban');
    await pressAtFocus('n');
    await waitFor(() => $$(app.el, 'button.kn-option').length > 0, 'the new-card picker');
  });
});
