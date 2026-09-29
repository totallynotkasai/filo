/**
 * Characterisation — the toolbar's Undo does what Ctrl+Z does.
 *
 * While a note's editor has the focus, Ctrl+Z undoes typing there; the
 * toolbar button says so and does the same, rather than undoing a board step
 * behind the text the user is looking at.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, type CharApp } from './harness/app';
import {
  $$,
  editors,
  openNoteFromSidebar,
  caretAfter,
  typeKeys,
  toolbarUndoLabel,
  clickToolbarUndo,
} from './harness/actions';

type Editor = ReturnType<typeof editors>[number];

afterEach(async () => {
  await stopApp();
});

function noteEditor(app: CharApp): Editor {
  const [ed] = editors($$(app.el, '.document-board')[0]);
  return ed;
}

describe('the toolbar Undo while typing', () => {
  it('undoes the typing in the focused note', async () => {
    const note = '---\ntitle: Plan\n---\nHello\n';
    const app = await startApp({ 'Plan.md': note });
    await openNoteFromSidebar(app, 'Plan.md');
    const ed = noteEditor(app);
    await caretAfter(ed, 'Hello');
    await typeKeys(ed, ' world');
    expect(ed.getText()).toContain('Hello world');
    await waitFor(() => toolbarUndoLabel(app) === 'Undo typing', 'the button to name typing');

    await clickToolbarUndo(app);
    await waitFor(() => !ed.getText().includes('world'), 'the typing undone');
    await quiesce(1200);
    expect(app.read('Plan.md')).toBe(note);
  });
});
