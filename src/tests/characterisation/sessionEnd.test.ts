/**
 * Characterisation — Windows ending the session (shutdown, restart,
 * sign-out) while Filo is open.
 *
 * Main keeps a note of whether leaving now could lose work, and when Windows
 * asks, the renderer saves what it can and keeps a rescue copy of the rest in
 * `.filo/recovery/`, with no dialog, then says it is done.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, recoveryCopies, endWindowsSession, unsavedStateReports } from './harness/app';
import { $$, editors, openNoteFromSidebar, typeAtEnd } from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const NOTE = '---\ntitle: Note\n---\nFirst line\n';

describe('Windows ends the session', () => {
  it('main is told when work could be lost, and again once it is saved and the field left', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    const reports = unsavedStateReports(app);
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' more');
    await waitFor(() => reports.last() === true, 'a "could lose work" report');

    (document.activeElement as HTMLElement | null)?.blur();
    await quiesce(1500);
    await waitFor(() => reports.last() === false, 'a "nothing to lose" report');
    expect(app.read('Note.md')).toContain('First line more');
  });

  it('typed text is saved', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    const reports = unsavedStateReports(app);
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' typed before the restart');
    await waitFor(() => reports.last() === true, 'a "could lose work" report');

    await endWindowsSession(app);
    expect(app.read('Note.md')).toContain('typed before the restart');
  });

  it('a change that can\'t be saved is kept in .filo/recovery, with no dialog', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' unsaved words');
    app.deleteExternally('Note.md');

    await endWindowsSession(app);
    expect(document.querySelector('[role="alertdialog"], .confirm-dialog')).toBeNull();
    const copies = [...recoveryCopies(app)].filter(([rel]) => rel.includes('-unsaved/') && rel.endsWith('Note.md'));
    expect(copies).toHaveLength(1);
    expect(copies[0]![1]).toContain('First line unsaved words');
  });
});
