/**
 * Characterisation — looking is not writing. Opening, panning and closing
 * never change a note or a board file (the app's own `.filo/` state, e.g. the
 * saved camera position, may change).
 *
 * Pins what the user sees, not how the app does it. Phases 3–6 of the master
 * plan must keep these green without editing this file (only the harness
 * adapter may change).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, reopenVault, waitFor } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  placeNoteOnBoard,
  openNoteFromSidebar,
  closeActiveTab,
  showBoard,
  panAndZoomMindMap,
  mindMapTransform,
  mindMapTiles,
  kanbanCards,
  taskRows,
  recoveryPromptShown,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

/** Notes written by other apps: the shapes Filo must leave byte-identical. */
const FOREIGN_NOTES: Record<string, string> = {
  'Plain LF.md': '# Heading\n\nSome _emphasis_ and a list:\n\n- one\n- two\n',
  'Windows CRLF.md': '---\r\ntitle: Windows CRLF\r\ntags: [a, b]\r\n---\r\n# Title\r\n\r\nLine one\r\nLine two\r\n',
  'With BOM.md': '\uFEFF---\ntitle: With BOM\n---\nBody after a BOM\n',
  'Odd YAML.md': "---\n# a comment\nzip: 02134\ncolour: 0xFF00FF\nwhen: 2026-01-02\nquoted: 'single'\nlist: [x,   y]\n---\nBody\n",
  'Setext.md': 'Title\n=====\n\nSub\n---\n\n* star bullet\n\nText with trailing spaces  \nnext line\n',
};

describe('opening things never writes', () => {
  it('opening and closing each note in a Document tab leaves every byte alone', async () => {
    const app = await startApp(FOREIGN_NOTES);
    const before = app.snapshot();
    for (const rel of Object.keys(FOREIGN_NOTES)) {
      await openNoteFromSidebar(app, rel);
      await quiesce(600);
      await closeActiveTab(app);
    }
    await quiesce();
    expect(app.snapshot()).toEqual(before);
  });

  it('boards showing those notes, reopened after a relaunch, leave every byte alone', async () => {
    const app = await startApp(FOREIGN_NOTES);
    const notes = Object.keys(FOREIGN_NOTES);
    await createBoard(app, 'mindmap');
    for (const rel of notes) await placeNoteOnBoard(app, 'mindmap', rel);
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    for (const rel of notes) await placeNoteOnBoard(app, 'kanban', rel);
    await createBoard(app, 'tasklist');
    for (const rel of notes) await placeNoteOnBoard(app, 'tasklist', rel);
    await quiesce();
    for (const rel of notes) expect(app.read(rel)).toBe(FOREIGN_NOTES[rel]);

    await reopenVault(app);
    const before = app.snapshot();
    await showBoard(app, 'mindmap');
    await waitFor(() => mindMapTiles(app).length === notes.length, 'mind-map tiles');
    await showBoard(app, 'kanban');
    await waitFor(() => kanbanCards(app).length === notes.length, 'kanban cards');
    await showBoard(app, 'tasklist');
    await waitFor(() => taskRows(app).length === notes.length, 'task rows');
    await quiesce();
    expect(app.snapshot()).toEqual(before);
  });

  it('a normal close with open boards and a note leaves nothing to recover on the next launch', async () => {
    const app = await startApp({ 'Kept.md': '---\ntitle: Kept\n---\nSafe\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Kept.md');
    await createBoard(app, 'kanban');
    await openNoteFromSidebar(app, 'Kept.md');
    await quiesce();

    await reopenVault(app);
    await quiesce();
    expect(recoveryPromptShown()).toBe(false);
  });

  it('panning and zooming a mind map moves the view but writes no note or board file', async () => {
    const app = await startApp({ 'Map note.md': '---\ntitle: Map note\n---\nOn the map\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Map note.md');
    await reopenVault(app);
    await showBoard(app, 'mindmap');
    await quiesce();

    const before = app.snapshot();
    const view = mindMapTransform(app);
    await panAndZoomMindMap(app);
    expect(mindMapTransform(app)).not.toBe(view);
    expect(app.snapshot()).toEqual(before);
  });
});
