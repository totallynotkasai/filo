/**
 * Characterisation — undo then redo of a new tile brings back the same note.
 *
 * A new text tile gets a new note. Undo takes the tile off the board and
 * leaves the note on disk; redo must put the tile back on that note, with the
 * text typed into it, not on a new blank one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce } from './harness/app';
import {
  createBoard,
  addMindMapTextTile,
  editors,
  typeAtEnd,
  mindMapTiles,
  undo,
  redo,
  $$,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

describe('undo and redo of a new tile', () => {
  it('redo shows the same note with its text, and makes no new file', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const note = await addMindMapTextTile(app);
    const [ed] = editors($$(app.el, '.mindmap-board')[0]);
    await typeAtEnd(ed, 'Keep this text');
    await quiesce();
    expect(app.read(note)).toContain('Keep this text');
    const filesBefore = app.userFiles();

    await undo(app);
    await waitFor(() => mindMapTiles(app).length === 0, 'the tile gone');
    await redo(app);
    await waitFor(() => mindMapTiles(app).length === 1, 'the tile back');
    await quiesce();

    expect(mindMapTiles(app)[0]?.text).toBe('Keep this text');
    expect(app.userFiles()).toEqual(filesBefore);
    expect(app.read(note)).toContain('Keep this text');
  });
});
