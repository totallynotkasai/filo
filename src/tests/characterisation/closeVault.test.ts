/**
 * Characterisation — closing the vault (or opening another) saves first and
 * asks only when something couldn't be saved.
 *
 * With nothing left unsaved there is no dialog, even straight after a
 * keystroke. When a change can't be saved, the dialog names the file, and
 * "Close anyway" keeps a copy of the unsaved text in `.filo/recovery/`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, closeVault, openOtherVault, recoveryCopies } from './harness/app';
import { $$, editors, openNoteFromSidebar, typeAtEnd } from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const NOTE = '---\ntitle: Note\n---\nFirst line\n';

describe('close the vault', () => {
  it('with nothing unsaved: no dialog', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    await quiesce();

    const result = await closeVault(app);
    expect(result.done).toBe(true);
    expect(result.dialogs).toEqual([]);
  });

  it('straight after typing: no dialog, and the edit is on disk', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' typed just now');

    const result = await closeVault(app);
    expect(result.done).toBe(true);
    expect(result.dialogs).toEqual([]);
    expect(app.read('Note.md')).toContain('typed just now');
  });

  it("a change that can't be saved: the dialog names the file, and Cancel stays open", async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' unsaved words');
    app.deleteExternally('Note.md');

    const result = await closeVault(app, 'Cancel');
    expect(result.done).toBe(false);
    expect(result.dialogs).toHaveLength(1);
    const [dialog] = result.dialogs;
    const text = `${dialog.message}\n${dialog.detail ?? ''}`;
    expect(text).toContain('Note.md');
    expect(text).toContain('no longer exists');
    expect(dialog.buttons).not.toContain("Don't Save");
    expect(recoveryCopies(app).size).toBe(0);
  });

  it('"Close anyway" keeps the unsaved text in .filo/recovery', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' unsaved words');
    app.deleteExternally('Note.md');

    const result = await closeVault(app, 'Close anyway');
    expect(result.done).toBe(true);
    expect(result.dialogs).toHaveLength(1);
    expect(app.exists('Note.md')).toBe(false);
    const copies = [...recoveryCopies(app)].filter(([rel]) => rel.endsWith('Note.md'));
    expect(copies).toHaveLength(1);
    const [, text] = copies[0];
    expect(text).toContain('title: Note');
    expect(text).toContain('First line unsaved words');
  });
});

describe('open another vault', () => {
  it('straight after typing: no dialog, and the edit is on disk', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    await typeAtEnd(ed, ' typed just now');

    const result = await openOtherVault(app, { 'Other.md': '# Other\n' });
    expect(result.done).toBe(true);
    expect(result.dialogs).toEqual([]);
    expect(app.read('Note.md')).toContain('typed just now');
  });
});
