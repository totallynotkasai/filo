/**
 * Characterisation — line spacing is saved with the note.
 *
 * The toolbar's Line Spacing applies to the whole note and is saved in its
 * frontmatter (`lineSpacing:`), so it survives closing and reopening, every
 * view of the note shows it, "Default" removes it, and Ctrl+Z undoes it. A
 * note without its own spacing follows Settings → General, in every view.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseDocument } from 'yaml';
import { startApp, stopApp, quiesce, reopenVault, waitFor, type CharApp } from './harness/app';
import {
  $$,
  editors,
  openNoteFromSidebar,
  chooseLineSpacing,
  viewLineSpacing,
  createBoard,
  placeNoteOnBoard,
  mindMapTiles,
  undo,
  setDefaultLineSpacing,
  toolbarLineSpacingLabel,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const NOTE = '---\ntitle: Note\n---\nSome text\n';

function frontmatter(app: CharApp, rel: string): Record<string, unknown> {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(app.read(rel));
  return m ? ((parseDocument(m[1]).toJS() ?? {}) as Record<string, unknown>) : {};
}

function documentView(app: CharApp): HTMLElement {
  return $$(app.el, '.document-board')[0];
}

describe('toolbar line spacing', () => {
  it('is saved in the note, and is still there after reopening', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    await chooseLineSpacing(app, editors(documentView(app))[0], '2');
    expect(app.read('Note.md')).toBe('---\ntitle: Note\nlineSpacing: 2\n---\nSome text\n');
    expect(viewLineSpacing(documentView(app))).toBe('2');

    await reopenVault(app);
    await openNoteFromSidebar(app, 'Note.md');
    expect(viewLineSpacing(documentView(app))).toBe('2');
  });

  it('a tile of the same note on a board shows the same spacing', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    await chooseLineSpacing(app, editors(documentView(app))[0], '1.15');
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Note.md');
    await waitFor(() => mindMapTiles(app).length === 1, 'the note tile');
    expect(viewLineSpacing(mindMapTiles(app)[0].el)).toBe('1.15');
  });

  it('"Default" removes it from the note, the note takes the project default, and Ctrl+Z puts it back', async () => {
    const app = await startApp({ 'Note.md': '---\ntitle: Note\nlineSpacing: 2\n---\nSome text\n' });
    await openNoteFromSidebar(app, 'Note.md');
    expect(viewLineSpacing(documentView(app))).toBe('2');

    await chooseLineSpacing(app, editors(documentView(app))[0], 'Default');
    expect(frontmatter(app, 'Note.md').lineSpacing).toBeUndefined();
    expect(viewLineSpacing(documentView(app))).toBe('1.5');

    await undo(app);
    await quiesce();
    expect(frontmatter(app, 'Note.md').lineSpacing).toBe(2);
    expect(viewLineSpacing(documentView(app))).toBe('2');
  });
});

describe('project default line spacing', () => {
  it('a note without its own spacing uses Settings → General in every view, and the toolbar names it', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    expect(viewLineSpacing(documentView(app))).toBe('1.5');

    await setDefaultLineSpacing(app, '2');
    expect(viewLineSpacing(documentView(app))).toBe('2');
    editors(documentView(app))[0].commands.focus('start');
    await quiesce(300);
    expect(toolbarLineSpacingLabel(app)).toBe('Default (2.0)');

    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Note.md');
    await waitFor(() => mindMapTiles(app).length === 1, 'the note tile');
    expect(viewLineSpacing(mindMapTiles(app)[0].el)).toBe('2');
    // The setting belongs to the vault; the note file is untouched.
    expect(app.read('Note.md')).toBe(NOTE);
  });

  it("a note's own spacing wins over the project default", async () => {
    const app = await startApp({ 'Note.md': '---\ntitle: Note\nlineSpacing: 1.15\n---\nSome text\n' });
    await setDefaultLineSpacing(app, '2.5');
    await openNoteFromSidebar(app, 'Note.md');
    expect(viewLineSpacing(documentView(app))).toBe('1.15');
  });
});
