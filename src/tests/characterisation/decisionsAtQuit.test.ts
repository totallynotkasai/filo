/**
 * Characterisation: questions only the user can answer are waited on as
 * decisions, not reported as failed saves.
 *
 * - A board changed outside Filo while it has unsaved changes asks Reload or
 *   Keep local. Quitting then says it is waiting for that decision, names the
 *   board, comes up at once and raises no "Board not saved" toasts.
 * - A raw view whose note changed elsewhere shows a banner; quitting says it
 *   is waiting for a decision there too.
 * - Another program's board write just after a Filo save is noticed at once,
 *   not only by the next save.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, quitFromWindow, type CharApp } from './harness/app';
import {
  createBoard,
  addMindMapTextTile,
  openNoteFromSidebar,
  toggleRawView,
  typeInRawView,
  answerConfirm,
  confirmText,
  toastActions,
  errorToasts,
} from './harness/actions';
import { renameVault } from './harness/vaultFolders';

afterEach(async () => {
  await stopApp();
});

function boardFile(app: CharApp): string {
  const rel = app.userFiles().find((f) => f.endsWith('.board.json'));
  if (!rel) throw new Error('no board file');
  return rel;
}

/** The board as a newer Filo would have saved it: this build can't load it. */
function newerBoard(app: CharApp, rel: string): string {
  return JSON.stringify({ ...JSON.parse(app.read(rel)), version: 9, fromNewer: true }, null, 2);
}

const driftPromptShown = (): boolean => toastActions().includes('Reload') && toastActions().includes('Keep local');

describe('quitting while a question waits for an answer', () => {
  it('a board changed outside Filo: the quit dialog waits for the decision and names the board', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await addMindMapTextTile(app);
    // Past any own-echo window for that save: this case is about the quit.
    await quiesce(8000);
    const rel = boardFile(app);
    const newer = newerBoard(app, rel);
    app.writeExternally(rel, newer);
    await waitFor(() => errorToasts().some((t) => t.includes("couldn't be applied")), 'the failed-reload notice');

    // An edit on Filo's copy meets the other version: it asks, and waits.
    await addMindMapTextTile(app);
    await waitFor(driftPromptShown, 'the Reload / Keep local question');

    const started = Date.now();
    const quit = await quitFromWindow(app);
    expect(quit.answer).toBe('awaiting-user');
    await waitFor(() => confirmText().includes('Waiting for your decision'), 'the decision form of the quit dialog');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(confirmText()).toContain(rel);
    expect(confirmText()).toContain('changed outside Filo, waiting for Reload or Keep local');
    expect(confirmText()).not.toContain('OneDrive');
    expect(errorToasts().filter((t) => t.includes('not saved'))).toEqual([]);

    await answerConfirm(app, { confirm: false });
    expect(await quit.quitDone).toBe('cancel');
    expect(app.read(rel)).toBe(newer);
  });

  it('settings changed outside Filo while a settings change waits: the quit dialog waits for the decision', async () => {
    const app = await startApp();
    await quiesce(1500);
    const theirs = JSON.stringify({ ...JSON.parse(app.read('.filo/app.json')), name: 'Their Name' }, null, 2);
    app.writeExternally('.filo/app.json', theirs);
    await quiesce(800);

    // Saving the new name meets the other version: it asks, and nothing waits.
    await renameVault(app, 'My Name');
    await waitFor(driftPromptShown, 'the Reload / Keep local question');

    const started = Date.now();
    const quit = await quitFromWindow(app);
    expect(quit.answer).toBe('awaiting-user');
    await waitFor(() => confirmText().includes('Waiting for your decision'), 'the decision form of the quit dialog');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(confirmText()).toContain('.filo/app.json: these settings were changed outside Filo, waiting for Reload or Keep local');
    expect(confirmText()).not.toContain('OneDrive');
    expect(errorToasts().filter((t) => t.includes('not saved') || t.includes('Save failed'))).toEqual([]);

    await answerConfirm(app, { confirm: false });
    expect(await quit.quitDone).toBe('cancel');
    expect(app.read('.filo/app.json')).toBe(theirs);
  });

  it('a raw view whose note changed elsewhere: the quit dialog waits for the decision', async () => {
    const app = await startApp({ 'Plan.md': '---\ntitle: Plan\n---\nOriginal\n' });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await typeInRawView(app, '---\ntitle: Plan\n---\nTyped as text\n');
    app.writeExternally('Plan.md', '---\ntitle: Plan\n---\nTheirs\n');
    await quiesce(1200);

    const quit = await quitFromWindow(app);
    expect(quit.answer).toBe('awaiting-user');
    await waitFor(() => confirmText().includes('Waiting for your decision'), 'the decision form of the quit dialog');
    expect(confirmText()).toContain('Plan.md: changed while you were editing it as text');

    await answerConfirm(app, { confirm: false });
    expect(await quit.quitDone).toBe('cancel');
  });
});

describe("another program's board write just after a Filo save", () => {
  it('is noticed at once, without another edit', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    await addMindMapTextTile(app);
    const rel = boardFile(app);
    // Filo's save of the new tile has landed.
    await waitFor(() => /"tileDefs":\s*\{\s*"/.test(app.read(rel)), 'the tile in the board file');
    const saved = Date.now();

    // Well inside main's echo window for that save (about 7 s on Windows).
    await new Promise((r) => setTimeout(r, Math.max(0, 2000 - (Date.now() - saved))));
    app.writeExternally(rel, newerBoard(app, rel));
    await waitFor(
      () => errorToasts().some((t) => t.includes("couldn't be applied")) || driftPromptShown(),
      'a notice about the other version',
      3000,
    );
  });
});
