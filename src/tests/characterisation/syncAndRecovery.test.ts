/**
 * Characterisation — sync and recovery, after Audit-28 Phase 6A:
 *
 * - the copies in .filo/recovery raise no notice at every open; Settings →
 *   Recovery lists them by kind, and deletes them to the Recycle Bin;
 * - a board that two files share an id with is named once, by its own notice;
 * - a file dragged out of a hidden vault folder (a rescue copy, Syncthing's
 *   versions) is copied in, and what is typed into it is saved;
 * - a sync client's conflict copy of a note is named, live and at open, and
 *   Open the copy opens it; a numbered note is not a copy;
 * - a note another program renames over an open note keeps both texts;
 * - a folder renamed in Explorer is followed once, not once more per file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { startApp, stopApp, waitFor, quiesce, reopenVault, reopenVaultAfter, recoveryCopies, settle } from './harness/app';
import {
  activeTabName,
  boardFilesText,
  chooseToastAction,
  closeModal,
  createBoard,
  diskConflictPrompt,
  dropFromExplorer,
  editors,
  errorToasts,
  keepMine,
  mindMapTiles,
  openNoteFromSidebar,
  placeNoteOnBoard,
  splitActiveTabRight,
  toastActions,
  toastTexts,
  typeAtEnd,
  $$,
} from './harness/actions';
import {
  countWatcherRenames,
  deleteAllInRecoverySection,
  deleteRecoveryCopy,
  openRecoverySettings,
  recoverySections,
  recycledPaths,
  walkVaultNow,
} from './harness/recovery';

afterEach(async () => {
  await stopApp();
});

const KEPT = '.filo/recovery/2026-10-02T09-30-00.000-keep/Journal.md';
const RESCUE = '.filo/recovery/2026-10-01T10-00-00.000-unsaved/Notes__Draft.md';
const COPY = 'Chapter.sync-conflict-20261004-120000-ABCDEFG.md';

/** Notices that talk about .filo/recovery. */
function recoveryNotices(): string[] {
  return toastTexts().filter((t) => t.includes('.filo/recovery'));
}

describe('the copies in .filo/recovery', () => {
  it('a kept version and a rescue copy raise no notice when the vault opens, then or later', async () => {
    const app = await startApp({
      'Journal.md': '---\ntitle: Journal\n---\nShort now\n',
      [KEPT]: '---\ntitle: Journal\n---\nThe longer version\n',
      [RESCUE]: '---\ntitle: Draft\n---\nTyped before the shutdown\n',
    });
    await quiesce(1500);
    expect(recoveryNotices()).toEqual([]);
    await reopenVault(app);
    await quiesce(1500);
    expect(recoveryNotices()).toEqual([]);
  });

  it('Settings → Recovery lists them by kind; Delete and Delete all send them to the Recycle Bin', async () => {
    const app = await startApp({
      'Journal.md': '---\ntitle: Journal\n---\nShort now\n',
      [KEPT]: '---\ntitle: Journal\n---\nThe longer version\n',
      [RESCUE]: '---\ntitle: Draft\n---\nTyped before the shutdown\n',
    });
    await quiesce(800);
    await openRecoverySettings(app);
    expect(recoverySections()).toEqual({ 'Kept versions': ['Journal.md'], 'Rescue copies': ['Notes/Draft.md'] });

    await deleteRecoveryCopy('Notes/Draft.md');
    expect(app.exists(RESCUE)).toBe(false);
    expect(recycledPaths().some((p) => p.replace(/\\/g, '/').endsWith(RESCUE))).toBe(true);
    // Its timestamped folder held nothing else, so it went too.
    expect(app.exists('.filo/recovery/2026-10-01T10-00-00.000-unsaved')).toBe(false);

    await deleteAllInRecoverySection('Kept versions');
    expect(app.exists(KEPT)).toBe(false);
    expect(recoverySections()).toEqual({});
    expect(app.read('Journal.md')).toBe('---\ntitle: Journal\n---\nShort now\n');
    await closeModal();
  });

  it('a board two files share an id with is named once, by its own notice, and not again at the next open', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    const [board] = app.userFiles().filter((f) => f.endsWith('.board.json'));
    if (!board) throw new Error('no board file');
    await reopenVaultAfter(app, () => {
      copyFileSync(app.abs(board), app.abs(board.replace(/[^/]+\.board\.json$/, 'Copy.board.json')));
    });
    await quiesce(1500);
    const notices = recoveryNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/Two board files use the same id/);
    for (const copy of recoveryCopies(app).keys()) expect(copy).toMatch(/Copy\.board\.json$/);

    await reopenVault(app);
    await quiesce(1500);
    // The duplicate is still there, so its own notice comes back; nothing else does.
    expect(recoveryNotices().filter((t) => !/Two board files use the same id/.test(t))).toEqual([]);
  });
});

describe('files dragged out of a hidden vault folder', () => {
  it('a rescue copy dragged onto a board is copied into the vault, and what is typed into it is saved there', async () => {
    const app = await startApp({ [RESCUE]: '---\ntitle: Draft\n---\nRecovered text\n' });
    await createBoard(app, 'mindmap');
    await dropFromExplorer(app, 'mindmap', app.abs(RESCUE));
    await waitFor(() => mindMapTiles(app).length === 1, 'the dropped tile');
    await quiesce(800);
    await typeAtEnd(editors(app.el)[0]!, ' and more');
    await quiesce(2500);
    expect(errorToasts()).toEqual([]);
    const copied = app.userFiles().filter((f) => f.endsWith('.md') && app.read(f).includes('Recovered text'));
    expect(copied).toHaveLength(1);
    expect(app.read(copied[0]!)).toContain('Recovered text and more');
    // The rescue copy itself is as it was.
    expect(app.read(RESCUE)).toBe('---\ntitle: Draft\n---\nRecovered text\n');
  });

  it("a note from Syncthing's versions folder is copied in too, so its edits don't land in the archive", async () => {
    const OLD = '.stversions/Chapter~20261001-100000.md';
    const app = await startApp({ [OLD]: '---\ntitle: Chapter\n---\nAn older draft\n' });
    await createBoard(app, 'mindmap');
    await dropFromExplorer(app, 'mindmap', app.abs(OLD));
    await waitFor(() => mindMapTiles(app).length === 1, 'the dropped tile');
    await quiesce(800);
    await typeAtEnd(editors(app.el)[0]!, ', revised');
    await quiesce(2500);
    expect(app.read(OLD)).toBe('---\ntitle: Chapter\n---\nAn older draft\n');
    expect(app.userFiles().some((f) => !f.startsWith('.') && app.read(f).includes('An older draft, revised'))).toBe(true);
  });
});

describe("a sync client's conflict copy of a note", () => {
  it('arriving beside its note is named, and Open the copy opens it', async () => {
    const app = await startApp({ 'Chapter.md': '---\ntitle: Chapter\n---\nPC text\n' });
    await quiesce(800);
    app.writeExternally(COPY, '---\ntitle: Chapter\n---\nPhone text\n');
    await waitFor(() => toastTexts().some((t) => t.includes(COPY)), 'the conflict notice');
    const notice = toastTexts().find((t) => t.includes(COPY))!;
    expect(notice).toMatch(/Syncthing kept two versions of the note "Chapter\.md": the other is Chapter\.sync-conflict-20261004-120000-ABCDEFG\.md/);
    await chooseToastAction('Open the copy');
    await waitFor(() => editors(app.el).some((ed) => ed.getText().includes('Phone text')), 'the copy open');
    expect(activeTabName(app)).toMatch(/Chapter/);
  });

  it('when the other version wins, the open note shows it and the notice names where the PC version went', async () => {
    const app = await startApp({ 'Chapter.md': '---\ntitle: Chapter\n---\nPC text\n' });
    await openNoteFromSidebar(app, 'Chapter.md');
    await quiesce(800);
    // Syncthing: the losing local file is renamed to the conflict name, then
    // the other version lands under the original name (temp file + rename).
    renameSync(app.abs('Chapter.md'), app.abs(COPY));
    writeFileSync(app.abs('~syncthing~Chapter.md.tmp'), '---\ntitle: Chapter\n---\nPhone text\n');
    renameSync(app.abs('~syncthing~Chapter.md.tmp'), app.abs('Chapter.md'));
    await waitFor(() => toastTexts().some((t) => t.includes(COPY)), 'the conflict notice');
    await waitFor(() => editors(app.el).some((ed) => ed.getText().includes('Phone text')), 'the note showing the other version');
    expect(app.read(COPY)).toContain('PC text');
  });

  it('copies already in the vault are named at open; a numbered note beside another is not a copy', async () => {
    await startApp({
      'Chapter.md': '---\ntitle: Chapter\n---\nPC text\n',
      [COPY]: '---\ntitle: Chapter\n---\nPhone text\n',
      'Part.md': 'One\n',
      'Part 2.md': 'Two\n',
    });
    await quiesce(1500);
    const notices = toastTexts().filter((t) => /kept two versions/.test(t));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(COPY);
    expect(toastActions()).toContain('Open the copy');
  });
});

describe('outside renames', () => {
  const A_BODY = 'Alpha paragraph that only note A holds. '.repeat(12);
  const B_BODY = 'Bravo paragraph that only note B holds. '.repeat(12);

  it('a note another program renames over an open note with typing keeps both texts', async () => {
    const app = await startApp({
      'A.md': `---\ntitle: A\n---\n${A_BODY}\n`,
      'B.md': `---\ntitle: B\n---\n${B_BODY}\n`,
    });
    await openNoteFromSidebar(app, 'A.md');
    await quiesce(500);
    await splitActiveTabRight(app);
    await openNoteFromSidebar(app, 'B.md');
    await quiesce(1500);
    const docs = $$(app.el, '.document-board');
    expect(docs.length).toBe(2);
    await typeAtEnd(editors(docs[1]!)[0]!, ' TYPED-IN-B');
    await settle(40);
    // Another program: "replace B with A".
    renameSync(app.abs('A.md'), app.abs('B.md'));
    await waitFor(() => diskConflictPrompt(), 'the prompt about B');
    // While the question is open nothing writes over A's text: B's typing
    // waits for the answer.
    await quiesce(4000);
    expect(app.read('B.md')).toContain('Alpha paragraph');
    await keepMine();
    await quiesce(1500);
    expect(app.read('B.md')).toContain('TYPED-IN-B');
    // Keep mine kept the version it wrote over.
    expect([...recoveryCopies(app).values()].some((t) => t.includes('Alpha paragraph'))).toBe(true);
  });

  it('a folder renamed in Explorer is followed once, and the next walk reports nothing more', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`Notes/n${i}.md`] = `---\ntitle: N${i}\n---\nBody ${i} ${'x'.repeat(i * 31)}\n`;
    const app = await startApp(files);
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Notes/n3.md');
    await quiesce(1500);
    const renames = countWatcherRenames();
    app.renameExternally('Notes', 'Chapters');
    await waitFor(() => boardFilesText(app).some((t) => t.includes('Chapters/n3.md')), 'the board following the folder');
    await quiesce(1500);
    const followed = renames.count;
    await walkVaultNow();
    renames.stop();
    expect(renames.count - followed).toBe(0);
    expect(boardFilesText(app).some((t) => t.includes('Notes/n3.md'))).toBe(false);
  });
});

