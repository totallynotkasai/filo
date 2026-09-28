/**
 * Characterisation — a raw-view save stands on the bytes it wrote, never on a
 * later read.
 *
 * A change another view queued while the raw save ran (a Task List tick)
 * lands on top of it. If the user typed on meanwhile, their next save must not
 * write over that change unseen: the raw view shows its conflict banner and
 * the change stays on disk.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor } from './harness/app';
import {
  createBoard,
  placeNoteOnBoard,
  splitActiveTabRight,
  showBoard,
  openNoteFromSidebar,
  toggleRawView,
  rawTextArea,
  rawConflictShown,
  taskRows,
  click,
  $,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const NOTE = '---\ntitle: Buy milk\ncompleted: false\n---\nOne\n';

function setRawText(ta: HTMLTextAreaElement, text: string): void {
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('raw view and a change queued during its save', () => {
  it('typing on during a save, then a Task List tick, then saving again: the tick is kept and the banner shows', async () => {
    const app = await startApp({ 'Buy milk.md': NOTE });
    await createBoard(app, 'tasklist');
    await placeNoteOnBoard(app, 'tasklist', 'Buy milk.md');
    await openNoteFromSidebar(app, 'Buy milk.md');
    await splitActiveTabRight(app);
    await showBoard(app, 'tasklist');
    await toggleRawView(app);
    const ta = await rawTextArea(app);
    await waitFor(() => taskRows(app).length > 0, 'the task row');

    ta.focus();
    setRawText(ta, '---\ntitle: Buy milk\ncompleted: false\n---\nTwo\n');
    // Leaving the field starts the save; the tick and more typing arrive while it runs.
    ta.blur();
    click($(taskRows(app)[0].el, '.task-checkbox'));
    ta.focus();
    setRawText(ta, '---\ntitle: Buy milk\ncompleted: false\n---\nThree\n');
    await quiesce(1500);

    ta.blur();
    await quiesce(1500);

    expect(app.read('Buy milk.md')).toContain('completed: true');
    expect(rawConflictShown(app)).toBe(true);
  });
});
