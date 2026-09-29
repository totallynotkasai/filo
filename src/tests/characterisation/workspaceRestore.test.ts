/**
 * Characterisation — the workspace a vault reopens with.
 *
 * Document tabs come back after a relaunch like board tabs, in their order,
 * with the one that was active still active. A tab follows its note through
 * a rename, and a note that is gone by the next launch leaves no tab.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, reopenVault, reopenVaultAfter, waitFor } from './harness/app';
import {
  activeTabName,
  createBoard,
  openNoteFromSidebar,
  openTabs,
  renameInSidebar,
  unloadedBoardShown,
  retryUnloadedBoardTab,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const NOTES = {
  'Alpha.md': '---\ntitle: Alpha\n---\nFirst note.\n',
  'Beta.md': '---\ntitle: Beta\n---\nSecond note.\n',
};

describe('Document tabs across a relaunch', () => {
  it('come back in order, with the active tab still active', async () => {
    const app = await startApp(NOTES);
    await createBoard(app, 'mindmap');
    await openNoteFromSidebar(app, 'Alpha.md');
    await openNoteFromSidebar(app, 'Beta.md');
    const before = openTabs(app);
    expect(before.filter((t) => t.endsWith('(document)'))).toEqual(['Alpha (document)', 'Beta (document)']);

    await reopenVault(app);
    expect(openTabs(app)).toEqual(before);
    expect(activeTabName(app)).toBe('Beta');
  });

  it('follow a rename, and the new path is the one reopened', async () => {
    const app = await startApp(NOTES);
    await openNoteFromSidebar(app, 'Alpha.md');
    await renameInSidebar(app, 'Alpha.md', 'Renamed');
    await waitFor(() => app.read('.filo/workspace.json').includes('Renamed.md'), 'workspace.json names the new path');

    await reopenVault(app);
    expect(openTabs(app)).toEqual(['Alpha (document)']);
  });

  it('a note deleted while the vault was closed leaves no tab', async () => {
    const app = await startApp(NOTES);
    await openNoteFromSidebar(app, 'Alpha.md');
    await openNoteFromSidebar(app, 'Beta.md');
    await waitFor(() => app.read('.filo/workspace.json').includes('Beta.md'), 'workspace.json names both notes');

    await reopenVaultAfter(app, () => app.deleteExternally('Beta.md'));
    expect(openTabs(app)).toEqual(['Alpha (document)']);
    expect(activeTabName(app)).toBe('Alpha');
  });
});

describe('a board tab whose board fails to load', () => {
  it('stays open, saying so, and Retry brings the board back once the file is fixed', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const rel = 'Mind Map 1.board.json';
    await waitFor(() => app.exists(rel) && app.read('.filo/workspace.json').includes(rel), 'workspace.json names the board file');
    const good = app.read(rel);
    const tabsBefore = openTabs(app);

    await reopenVaultAfter(app, () => app.writeExternally(rel, '{ "version": 8, "board": '));
    expect(openTabs(app)).toEqual(tabsBefore);
    expect(unloadedBoardShown(app)).toBe(`Filo couldn't open "Mind Map 1"`);
    expect(app.read(rel)).toBe('{ "version": 8, "board": ');

    app.writeExternally(rel, good);
    await retryUnloadedBoardTab(app);
    await waitFor(() => app.el.querySelector('.mindmap-board') !== null, 'the board shown in its tab');
    expect(unloadedBoardShown(app)).toBeNull();
    expect(openTabs(app)).toEqual(tabsBefore);
  });
});
