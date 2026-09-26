/**
 * Characterisation — text typed in a note's raw view is unsaved work like any
 * other, and nothing typed there disappears without a trace.
 *
 * Closing the vault or quitting from the window saves it (quit never unmounts
 * the view). When it can't be written because the note changed elsewhere,
 * the quit dialog names it and "Quit anyway" keeps a copy. Switching back to
 * the formatted view keeps the raw view, with its banner, until the text is
 * on disk; closing the tab then keeps a copy in `.filo/recovery/`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, closeVault, quitFromWindow, recoveryCopies } from './harness/app';
import {
  openNoteFromSidebar,
  toggleRawView,
  typeInRawView,
  leaveRawFieldAndToggle,
  rawViewShown,
  rawConflictShown,
  closeActiveTab,
  answerConfirm,
  toastTexts,
  confirmText,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const NOTE = '---\ntitle: Plan\n---\nOriginal\n';
const MINE = '---\ntitle: Plan\n---\nTyped in the raw view\n';

describe('raw view and leaving', () => {
  it('closing the vault saves what was typed in the raw view', async () => {
    const app = await startApp({ 'Plan.md': NOTE });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await typeInRawView(app, MINE);

    const left = await closeVault(app);
    expect(left.done).toBe(true);
    expect(left.dialogs).toEqual([]);
    expect(app.read('Plan.md')).toBe(MINE);
  });

  it('quitting from the window saves what was typed in the raw view', async () => {
    const app = await startApp({ 'Plan.md': NOTE });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await typeInRawView(app, MINE);

    const quit = await quitFromWindow(app);
    expect(quit.answer).toBe('ready');
    expect(app.read('Plan.md')).toBe(MINE);
  });

  it('a quit that can\'t save the raw text asks, and Quit anyway keeps a copy', async () => {
    const app = await startApp({ 'Plan.md': NOTE });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await typeInRawView(app, MINE);
    app.writeExternally('Plan.md', '---\ntitle: Plan\n---\nTheirs\n');
    await quiesce(1200);

    const quit = await quitFromWindow(app);
    expect(quit.answer).toBe('awaiting-user');
    await waitFor(() => confirmText().includes('Plan.md'), 'the quit dialog naming the note');
    await answerConfirm(app, { confirm: true });
    expect(await quit.quitDone).toBe('ready');
    expect(app.read('Plan.md')).toBe('---\ntitle: Plan\n---\nTheirs\n');
    expect([...recoveryCopies(app).values()]).toContain(MINE);
  });
});

describe('raw view after a change made elsewhere', () => {
  it('switching back keeps the raw view and its banner; closing the tab keeps a copy', async () => {
    const app = await startApp({ 'Plan.md': NOTE });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await typeInRawView(app, MINE);
    app.writeExternally('Plan.md', '---\ntitle: Plan\nstatus: open\n---\nOriginal\n');
    await quiesce(1200);

    await toggleRawView(app);
    expect(rawViewShown(app)).toBe(true);
    await waitFor(() => rawConflictShown(app), 'the raw conflict banner');

    await closeActiveTab(app);
    await answerConfirm(app, { confirm: true });
    await waitFor(() => [...recoveryCopies(app).values()].includes(MINE), 'a rescue copy of the raw text');
    await waitFor(() => toastTexts().some((t) => t.includes('raw edits to "Plan.md" were kept')), 'the rescue toast');
    expect(app.read('Plan.md')).toBe('---\ntitle: Plan\nstatus: open\n---\nOriginal\n');
  });

  it('leaving the field and toggling at once still waits for the save\'s answer', async () => {
    const app = await startApp({ 'Plan.md': NOTE });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await typeInRawView(app, MINE);
    app.writeExternally('Plan.md', '---\ntitle: Plan\n---\nTheirs\n');
    await quiesce(1200);

    await leaveRawFieldAndToggle(app);
    expect(rawViewShown(app)).toBe(true);
    await waitFor(() => rawConflictShown(app), 'the raw conflict banner');
    expect(app.read('Plan.md')).toBe('---\ntitle: Plan\n---\nTheirs\n');
  });
});
