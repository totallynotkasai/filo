/**
 * Characterisation — what the user is told when something is broken, and
 * that the offered way out works.
 *
 * A board that can't be opened says why and where the copy is; a note
 * deleted under an open Document tab says so and can come back from the
 * trash; a text tile whose note is gone can have it recreated (and is never
 * told "Synced" meanwhile); a media tile whose file is gone says "File not
 * found"; a file tile can be re-linked to a file of any type.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce } from './harness/app';
import {
  $,
  $$,
  createBoard,
  placeNoteOnBoard,
  dragFromSidebar,
  openNoteFromSidebar,
  deleteInSidebar,
  mindMapTiles,
  toastTexts,
  chooseToastAction,
  chooseMenuItem,
} from './harness/actions';
import {
  documentBanners,
  documentBannerActions,
  chooseDocumentBannerAction,
  brokenBadgeShown,
  brokenTileMenuLabels,
  chooseBrokenTileAction,
  syncTileToDisk,
  mediaFailsToLoad,
  mediaErrorShown,
  relinkChoices,
  shownInFolderPaths,
} from './harness/errorStates';

afterEach(async () => {
  await stopApp();
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('a board that fails to load', () => {
  it('says what is wrong, where the copy is, and Show in folder opens the copy', async () => {
    await startApp({ 'Broken.board.json': '{ "version": 8, "board": ', 'Note.md': 'x\n' });
    await waitFor(() => toastTexts().some((t) => t.includes('Broken.board.json')), 'the load-failure notice');
    const notice = toastTexts().find((t) => t.includes('Broken.board.json')) ?? '';
    expect(notice).toContain("isn't valid JSON");
    expect(notice).toContain('A copy is in .filo/recovery. Fix the file in a text editor, then reopen the vault.');

    await chooseToastAction('Show in folder');
    const shown = shownInFolderPaths().at(-1) ?? '';
    expect(shown.replace(/\\/g, '/')).toMatch(/\/\.filo\/recovery\/.+Broken\.board\.json$/);
  });

  it('a board from a newer Filo says to update Filo, with the same copy', async () => {
    const future = JSON.stringify({ version: 99, board: { id: 'b1' } });
    await startApp({ 'Future.board.json': future });
    await waitFor(() => toastTexts().some((t) => t.includes('Future.board.json')), 'the load-failure notice');
    const notice = toastTexts().find((t) => t.includes('Future.board.json')) ?? '';
    expect(notice).toContain('newer version of Filo');
    expect(notice).toContain('A copy is in .filo/recovery. Update Filo, then reopen the vault.');
  });
});

describe('a Document tab whose note is gone', () => {
  it('deleted in Filo: says so, and Restore from Trash brings it back into the tab', async () => {
    const note = '---\ntitle: Plan\n---\nKeep this\n';
    const app = await startApp({ 'Plan.md': note });
    await openNoteFromSidebar(app, 'Plan.md');
    await deleteInSidebar(app, 'Plan.md');
    await waitFor(() => documentBanners(app).includes('This note was deleted or moved.'), 'the missing banner');
    await waitFor(() => documentBannerActions(app).includes('Restore from Trash'), 'Restore from Trash');
    expect(documentBannerActions(app)).toContain('Close tab');

    await chooseDocumentBannerAction(app, 'Restore from Trash');
    await waitFor(() => app.exists('Plan.md'), 'the note back on disk');
    expect(app.read('Plan.md')).toBe(note);
    await waitFor(() => !documentBanners(app).includes('This note was deleted or moved.'), 'the banner gone');
  });

  it('deleted by another program: no Restore, and Close tab closes the tab', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\n---\nText\n' });
    await openNoteFromSidebar(app, 'Plan.md');
    const tabsBefore = $$(app.el, '.tab[role="tab"]').length;
    app.deleteExternally('Plan.md');
    await waitFor(() => documentBanners(app).includes('This note was deleted or moved.'), 'the missing banner', 25000);
    await quiesce(500);
    expect(documentBannerActions(app)).not.toContain('Restore from Trash');

    await chooseDocumentBannerAction(app, 'Close tab');
    await waitFor(() => $$(app.el, '.tab[role="tab"]').length === tabsBefore - 1, 'the tab closed');
  });
});

describe('a text tile whose note is gone', () => {
  it('Sync never says "Synced", and Recreate backing file puts the note back with its title', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\ntags: [work]\n---\nBody\n' });
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Plan.md');
    const tile = mindMapTiles(app)[0].el;
    app.deleteExternally('Plan.md');
    await waitFor(() => brokenBadgeShown(tile), 'the broken badge', 25000);

    await syncTileToDisk(tile);
    expect(toastTexts()).not.toContain('Synced');
    expect(app.exists('Plan.md')).toBe(false);

    await chooseBrokenTileAction(app, tile, 'Recreate backing file');
    await waitFor(() => app.exists('Plan.md'), 'the note recreated');
    const text = app.read('Plan.md');
    expect(text).toContain('title: Plan');
    expect(text).toContain('Body');
    await waitFor(() => !brokenBadgeShown(mindMapTiles(app)[0].el), 'the badge gone');
  });
});

describe('a media tile whose file is gone', () => {
  it('says "File not found", not a format error, and offers no Recreate', async () => {
    const app = await startApp({ 'pic.png': PNG });
    await createBoard(app, 'mindmap');
    await dragFromSidebar(app, 'pic.png', $(app.el, '.mindmap-board'));
    await waitFor(() => mindMapTiles(app).length === 1, 'the image tile');
    const tile = mindMapTiles(app)[0].el;

    await mediaFailsToLoad(tile);
    expect(mediaErrorShown(tile)).toBe('Image could not be loaded');

    app.deleteExternally('pic.png');
    await waitFor(() => brokenBadgeShown(tile), 'the broken badge', 25000);
    await mediaFailsToLoad(tile);
    await waitFor(() => mediaErrorShown(tile) === 'File not found', '"File not found"');
    expect(await brokenTileMenuLabels(app, tile)).not.toContain('Recreate backing file');
  });
});

describe('re-linking a file tile', () => {
  it('offers files of any type', async () => {
    const app = await startApp({ 'Report.docx': 'doc', 'data.xyz': 'x', 'notes.md': 'n\n' });
    await createBoard(app, 'mindmap');
    await dragFromSidebar(app, 'Report.docx', $(app.el, '.mindmap-board'));
    await waitFor(() => mindMapTiles(app).length === 1, 'the file tile');
    const tile = mindMapTiles(app)[0].el;
    app.deleteExternally('Report.docx');
    await brokenTileMenuLabels(app, tile);
    await chooseMenuItem(app, 'Re-link to another file…');
    const choices = await relinkChoices();
    expect(choices).toContain('data.xyz');
    expect(choices).toContain('notes.md');
    expect(choices.some((c) => c.endsWith('.board.json'))).toBe(false);
  });
});
