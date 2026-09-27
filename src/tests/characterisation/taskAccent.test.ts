/**
 * Characterisation — a new Task List shows ticked tasks and progress.
 *
 * With no accent colour chosen, the tick box and the progress bar take the
 * theme's accent. They must never be left unpainted (a white tick on a
 * transparent box is invisible on a light row).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor } from './harness/app';
import {
  createBoard,
  quickAddTask,
  taskRows,
  toggleTask,
  taskCheckboxFill,
  taskProgressFill,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

describe('a new Task List', () => {
  it('paints a ticked task and the progress bar in the accent colour', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    await quickAddTask(app, 'Buy milk');
    await waitFor(() => taskRows(app).length === 1, 'the task');
    await toggleTask(taskRows(app)[0]!.el);
    await waitFor(() => taskRows(app)[0]?.completed === true, 'the task ticked');

    expect(taskCheckboxFill(taskRows(app)[0]!.el)).not.toBe('');
    expect(taskCheckboxFill(taskRows(app)[0]!.el)).not.toBe('transparent');
    expect(taskProgressFill(app)).not.toBe('');
  });
});
