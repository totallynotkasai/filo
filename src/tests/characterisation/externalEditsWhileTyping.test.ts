/**
 * Characterisation — another program saves a note while the user is typing
 * in it.
 *
 * Keys typed while Filo reads the other program's version were typed into the
 * old text. Neither version may disappear without a word: the user is asked
 * (Reload / Keep mine), and the other program's bytes stay on disk until they
 * answer. Keep mine backs those bytes up before writing over them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, whileReading, recoveryCopies } from './harness/app';
import { onLinux } from './harness/platform';
import { openNoteFromSidebar, editors, typeAtEnd, diskConflictPrompt, keepMine, $$ } from './harness/actions';

afterEach(async () => {
  await stopApp();
});

describe('typing while another program saves the note', () => {
  it.skipIf(onLinux)('keys typed during the read of their version ask first, and keep theirs on disk until answered', async () => {
    const app = await startApp({ 'Draft.md': '---\ntitle: Draft\n---\nStart\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();
    const editor = editors($$(app.el, '.document-board')[0])[0];
    await typeAtEnd(editor, ' one');
    await quiesce();
    expect(app.read('Draft.md')).toBe('---\ntitle: Draft\n---\nStart one\n');

    const theirs = '---\ntitle: Draft\n---\nStart one, and their line\n';
    await whileReading(
      app,
      'Draft.md',
      () => app.writeExternally('Draft.md', theirs),
      () => typeAtEnd(editor, ' two'),
    );
    await waitFor(() => diskConflictPrompt(), 'the disk-conflict prompt');
    await quiesce();
    expect(app.read('Draft.md')).toBe(theirs);

    await keepMine();
    await quiesce();
    expect(app.read('Draft.md')).toBe(`---\ntitle: Draft\n---\nStart one two\n`);
    expect([...recoveryCopies(app).values()]).toContain(theirs);
  });

  it('keys typed during the read of a frontmatter-only change keep both', async () => {
    const app = await startApp({ 'Draft.md': '---\ntitle: Draft\n---\nStart\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    await quiesce();
    const editor = editors($$(app.el, '.document-board')[0])[0];

    await whileReading(
      app,
      'Draft.md',
      () => app.writeExternally('Draft.md', '---\ntitle: Draft\nstatus: open\n---\nStart\n'),
      () => typeAtEnd(editor, ' typed'),
    );
    await quiesce();
    expect(diskConflictPrompt()).toBe(false);
    expect(app.read('Draft.md')).toBe(`---\ntitle: Draft\nstatus: open\n---\nStart typed\n`);
  });
});
