/**
 * Characterisation — alignment and indent set from the toolbar are saved.
 *
 * Markdown has no syntax for them, so the aligned or indented paragraph is
 * written as one HTML line and read back on the next open. The rest of the
 * note stays Markdown, and the note doesn't open read-only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, reopenVault } from './harness/app';
import { $$, editors, openNoteFromSidebar, alignFirstBlock, indentFirstBlock } from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const NOTE = '---\ntitle: Note\n---\nFirst **bold** line\n\nSecond line\n';

describe('toolbar alignment and indent', () => {
  it('a centred paragraph is saved, and is still centred after reopening', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    await alignFirstBlock(app, editors($$(app.el, '.document-board')[0])[0], 'center');
    await quiesce();
    expect(app.read('Note.md')).toBe(
      '---\ntitle: Note\n---\n<p style="text-align: center;">First <strong>bold</strong> line</p>\n\nSecond line\n',
    );

    await reopenVault(app);
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    expect(ed.getJSON().content?.[0]?.attrs?.textAlign).toBe('center');
    expect(ed.isEditable).toBe(true);
  });

  it('an indented paragraph is saved, and is still indented after reopening', async () => {
    const app = await startApp({ 'Note.md': NOTE });
    await openNoteFromSidebar(app, 'Note.md');
    await indentFirstBlock(app, editors($$(app.el, '.document-board')[0])[0]);
    await quiesce();
    expect(app.read('Note.md')).toContain('<p style="margin-left: 24px;">First <strong>bold</strong> line</p>');
    expect(app.read('Note.md')).toContain('\n\nSecond line\n');

    await reopenVault(app);
    await openNoteFromSidebar(app, 'Note.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);
    expect(ed.getJSON().content?.[0]?.attrs?.indent).toBe(1);
    expect(ed.isEditable).toBe(true);
  });
});
