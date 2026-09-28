/**
 * Characterisation — text typed in a note's raw view is unsaved work the whole
 * app can see: the save indicator shows it, a leave that keeps a rescue copy
 * leaves the crash sentinel naming it, and a leave the user calls off after
 * the copy failed leaves the view saving as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, closeVault, reopenVault, recoveryCopies } from './harness/app';
import {
  openNoteFromSidebar,
  toggleRawView,
  typeInRawView,
  editRawText,
  rawConflictShown,
  closeActiveTab,
  answerConfirm,
  recoveryPromptShown,
} from './harness/actions';
import { saveIndicator, recoveryModal } from './harness/saveState';

afterEach(async () => {
  await stopApp();
});

const NOTE = '---\ntitle: Plan\n---\nOriginal\n';
const THEIRS = '---\ntitle: Plan\n---\nTheirs\n';
const MINE = '---\ntitle: Plan\n---\nTyped in the raw view\n';
const MORE = '---\ntitle: Plan\n---\nTyped in the raw view, and more after staying\n';

describe('raw view typing and the save indicator', () => {
  it('shows as unsaved while typed, and as saved once the field is left', async () => {
    const app = await startApp({ 'Plan.md': NOTE });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    expect(saveIndicator(app)).toBe('saved');

    await typeInRawView(app, MINE);
    await waitFor(() => saveIndicator(app) === 'saving', 'the indicator showing unsaved raw text');

    await editRawText(app, MINE);
    await waitFor(() => saveIndicator(app) === 'saved', 'the indicator back to saved');
    expect(app.read('Plan.md')).toBe(MINE);
  });
});

describe('raw view and leaving the vault', () => {
  it('Close anyway with raw text in conflict: reopening the vault offers recovery', async () => {
    const app = await startApp({ 'Plan.md': NOTE });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await typeInRawView(app, MINE);
    app.writeExternally('Plan.md', THEIRS);
    await quiesce(1200);

    const left = await closeVault(app, 'Close anyway');
    expect(left.done).toBe(true);
    expect([...recoveryCopies(app).values()]).toContain(MINE);

    await reopenVault(app);
    await waitFor(() => recoveryPromptShown(), 'the recovery modal');
    expect(recoveryModal().rows.some((r) => r.includes('Plan.md'))).toBe(true);
  });

  it('a rescue that failed, then Cancel, then more typing: closing the tab keeps a copy of the new text', async () => {
    const app = await startApp({ 'Plan.md': NOTE });
    await openNoteFromSidebar(app, 'Plan.md');
    await toggleRawView(app);
    await typeInRawView(app, MINE);
    app.writeExternally('Plan.md', THEIRS);
    await quiesce(1200);

    // A file where the recovery folder should be: no copy can be written.
    app.deleteExternally('.filo/recovery');
    app.writeExternally('.filo/recovery', 'not a folder');
    const left = await closeVault(app, ['Close anyway', 'Cancel']);
    expect(left.done).toBe(false);
    expect(left.dialogs.length).toBe(2);

    app.deleteExternally('.filo/recovery');
    await typeInRawView(app, MORE);
    await closeActiveTab(app);
    await answerConfirm(app, { confirm: true });
    await waitFor(() => [...recoveryCopies(app).values()].includes(MORE), 'a rescue copy of the new raw text');
    expect(app.read('Plan.md')).toBe(THEIRS);
    expect(rawConflictShown(app)).toBe(false);
  });
});
