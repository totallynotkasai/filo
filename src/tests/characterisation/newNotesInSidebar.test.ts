/**
 * Characterisation — a note Filo creates is listed in the sidebar at once.
 *
 * A new card, task or text tile writes a new `.md`. The sidebar shows it
 * straight away, without waiting for the file watcher to report it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, type CharApp } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  addKanbanCard,
  quickAddTask,
  addMindMapTextTile,
  revealInSidebar,
  errorToasts,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

/** Well under the watcher's report of a new file (over 1.5 s here). */
const PROMPTLY_MS = 300;

async function expectListedPromptly(app: CharApp, rel: string): Promise<void> {
  await revealInSidebar(app, rel, PROMPTLY_MS);
  expect(errorToasts()).toEqual([]);
}

describe('a new note is listed in the sidebar at once', () => {
  it('Kanban: a new card', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    const rel = await addKanbanCard(app);
    await expectListedPromptly(app, rel);
  });

  it('Task List: a quick-added task', async () => {
    const app = await startApp();
    await createBoard(app, 'tasklist');
    const rel = await quickAddTask(app, 'Buy milk');
    await expectListedPromptly(app, rel);
  });

  it('Mind map: a new text tile', async () => {
    const app = await startApp();
    await createBoard(app, 'mindmap');
    const rel = await addMindMapTextTile(app);
    await expectListedPromptly(app, rel);
  });
});
