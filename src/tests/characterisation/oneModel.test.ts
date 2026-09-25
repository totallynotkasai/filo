/**
 * Characterisation — one note, one model: every view of a note shows the same
 * text, edits made by another program are merged or asked about exactly once,
 * and nothing typed is lost on quit.
 *
 * Pins what the user sees, not how the app does it (only the harness adapter
 * may change when internals move).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, quitApp } from './harness/app';
import {
  openNoteFromSidebar,
  splitActiveTabRight,
  editors,
  typeAtEnd,
  diskConflictPrompt,
  keepMine,
  toastActions,
  $$,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

describe('split panes on one note', () => {
  it('typing in one pane shows in the other, and typing there next lands too', async () => {
    const app = await startApp({ 'Shared.md': '---\ntitle: Shared\n---\nStart\n' });
    await openNoteFromSidebar(app, 'Shared.md');
    await splitActiveTabRight(app);
    const [a, b] = editors(app.el);
    expect(b.getText()).toBe('Start');

    await typeAtEnd(a, ' from A');
    await waitFor(() => b.getText() === 'Start from A', 'the other pane to show the text typed in the first');

    await typeAtEnd(b, ' then B');
    await waitFor(() => a.getText() === 'Start from A then B', 'the first pane to follow the second');
    await quiesce();
    expect(app.read('Shared.md')).toBe('---\ntitle: Shared\n---\nStart from A then B\n');
  });
});

describe('another program changes a note while the user types', () => {
  it('a frontmatter-only change keeps the typed text, takes the new key and asks nothing', async () => {
    const app = await startApp({ 'Idea.md': '---\ntitle: Idea\n---\nThe body\n' });
    await openNoteFromSidebar(app, 'Idea.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);

    await typeAtEnd(ed, ' grows');
    app.writeExternally('Idea.md', '---\ntitle: Idea\nstatus: draft\n---\nThe body\n');
    await quiesce(2500);
    expect(diskConflictPrompt()).toBe(false);
    expect(ed.getText()).toBe('The body grows');
    expect(app.read('Idea.md')).toBe('---\ntitle: Idea\nstatus: draft\n---\nThe body grows\n');
  });

  it('a body change asks once while typing goes on, and "keep mine" keeps every keystroke', async () => {
    const app = await startApp({ 'Draft.md': '---\ntitle: Draft\n---\nStart\n' });
    await openNoteFromSidebar(app, 'Draft.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);

    await typeAtEnd(ed, ' one');
    app.writeExternally('Draft.md', '---\ntitle: Draft\n---\nStart theirs\n');
    await waitFor(() => diskConflictPrompt(), 'the disk-conflict prompt');
    await typeAtEnd(ed, ' two');
    await quiesce(1500);
    expect(toastActions().filter((l) => l === 'Reload')).toHaveLength(1);
    expect(app.read('Draft.md')).toBe('---\ntitle: Draft\n---\nStart theirs\n');

    await keepMine();
    await quiesce();
    expect(app.read('Draft.md')).toBe('---\ntitle: Draft\n---\nStart one two\n');
  });
});

describe('quitting', () => {
  it('quitting straight after typing saves the text, well inside five seconds', async () => {
    const app = await startApp({ 'Log.md': '---\ntitle: Log\n---\nDay one\n' });
    await openNoteFromSidebar(app, 'Log.md');
    const [ed] = editors($$(app.el, '.document-board')[0]);

    await typeAtEnd(ed, ' and two');
    const elapsed = await quitApp(app);
    expect(elapsed).toBeLessThan(5000);
    expect(app.read('Log.md')).toBe('---\ntitle: Log\n---\nDay one and two\n');
  });
});
