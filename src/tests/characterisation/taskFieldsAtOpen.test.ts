/**
 * Characterisation — a Task List in a vault that is still being read at open.
 *
 * Rows can show before their notes' fields have been read. They show those
 * fields as loading, never as "not done"; and ticking a recurring task at the
 * first moment it can be ticked rolls it forward on disk, never completes it
 * for good.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, reopenVaultWhileReading, vaultReadFinished } from './harness/app';
import { createBoard, placeNoteOnBoard, taskRows, tickTaskWhenReady, taskFieldsPending } from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const TASK = 'Water plants.md';
const DUE = '2026-10-05';

function vaultOf300(): Record<string, string> {
  const files: Record<string, string> = {
    [TASK]: `---\ntitle: Water plants\ncompleted: false\ndueDate: ${DUE}\nrecurrence: weekly\n---\nEvery week.\n`,
  };
  for (let i = 0; i < 300; i++) {
    files[`Notes/Note ${String(i).padStart(3, '0')}.md`] = `---\ntitle: Note ${i}\ntags: [filler]\n---\nBody ${i}.\n`;
  }
  return files;
}

describe('a Task List while the vault is being read', () => {
  it('ticking a recurring task straight after open rolls it forward', async () => {
    const app = await startApp(vaultOf300());
    await createBoard(app, 'tasklist');
    await placeNoteOnBoard(app, 'tasklist', TASK);
    await waitFor(() => taskRows(app).some((r) => r.title === 'Water plants'), 'the task on the board');

    let pendingShownAsDone = false;
    await reopenVaultWhileReading(app, async () => {
      await waitFor(() => taskRows(app).some((r) => r.title === 'Water plants'), 'the task row after reopening');
      const row = taskRows(app).find((r) => r.title === 'Water plants');
      if (!row) throw new Error('no task row');
      // While its note is unread, the row doesn't claim the task isn't done.
      if (taskFieldsPending(row.el) && row.el.querySelector('.task-checkbox:not([disabled])')) pendingShownAsDone = true;
      await tickTaskWhenReady(row.el);
    });
    await quiesce(1200);
    expect(await vaultReadFinished()).toBe(true);

    expect(pendingShownAsDone).toBe(false);
    const disk = app.read(TASK);
    expect(disk).not.toContain('completed: true');
    expect(disk).toContain('recurrence: weekly');
    expect(disk).not.toContain(`dueDate: ${DUE}`);
    expect(disk).toMatch(/dueDate: \d{4}-\d{2}-\d{2}/);
  });
});
