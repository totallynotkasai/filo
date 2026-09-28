/**
 * Characterisation: a Task List whose board file another program (or another
 * machine, through a sync client) changed while it is open. The open board
 * takes the new view state (its filters), undo can't put back the version
 * from before the change, and a vault-wide tag rename reaches the filter of
 * a board on screen instead of being written back to the old tag.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, closeVault, type CharApp } from './harness/app';
import {
  createBoard,
  placeNoteOnBoard,
  taskRows,
  toastTexts,
  errorToasts,
  undo,
  renameTagEverywhere,
} from './harness/actions';
import { boardJson } from './harness/leaving';

afterEach(async () => {
  await stopApp();
});

const note = (title: string, tag: string): string => `---\ntitle: ${title}\ntags: [${tag}]\n---\nBody\n`;

function boardFile(app: CharApp): string {
  const rel = app.userFiles().find((f) => f.endsWith('.board.json'));
  if (!rel) throw new Error('no board file');
  return rel;
}

/** Another program sets the board's saved filter to `tags`. */
function setFilterOutside(app: CharApp, rel: string, tags: string[]): void {
  const file = JSON.parse(app.read(rel)) as { board: { settings?: Record<string, unknown> } };
  const settings = file.board.settings ?? {};
  settings.lastView = { ...(settings.lastView as Record<string, unknown> | undefined), filterTags: tags };
  file.board.settings = settings;
  app.writeExternally(rel, JSON.stringify(file, null, 2));
}

function savedFilter(app: CharApp, rel: string): unknown {
  const settings = boardJson(app, rel).settings as { lastView?: { filterTags?: unknown } } | undefined;
  return settings?.lastView?.filterTags;
}

async function openTaskListWithTwoTasks(): Promise<{ app: CharApp; rel: string }> {
  const app = await startApp({ 'Work.md': note('Work', 'work'), 'Home.md': note('Home', 'home') });
  await createBoard(app, 'tasklist');
  await placeNoteOnBoard(app, 'tasklist', 'Work.md');
  await placeNoteOnBoard(app, 'tasklist', 'Home.md');
  await waitFor(() => taskRows(app).length === 2, 'both tasks on the list');
  // The watcher takes a change to a board Filo just saved as its own echo for
  // a few seconds; the other program acts after that.
  await quiesce(8000);
  return { app, rel: boardFile(app) };
}

describe('a Task List changed outside Filo while it is open', () => {
  it('takes the new filter, and undo cannot put back the version from before', async () => {
    const { app, rel } = await openTaskListWithTwoTasks();

    setFilterOutside(app, rel, ['work']);
    await waitFor(() => taskRows(app).map((r) => r.title).join() === 'Work', 'the list to show only the work task');
    await waitFor(
      () => toastTexts().some((t) => t.includes('was cleared because the board changed outside Filo')),
      'the undo-history notice',
    );

    // Undo would have taken Home off the list with the pre-reload snapshot.
    await undo(app);
    await quiesce();
    const tasks = (boardJson(app, rel).tasks as unknown[]) ?? [];
    expect(tasks).toHaveLength(2);
    expect(savedFilter(app, rel)).toEqual(['work']);
    expect(errorToasts()).toEqual([]);
  });

  it('a vault-wide tag rename reaches the filter of the board on screen', async () => {
    const { app, rel } = await openTaskListWithTwoTasks();
    setFilterOutside(app, rel, ['work']);
    await waitFor(() => taskRows(app).length === 1, 'the filtered list');

    await renameTagEverywhere(app, 'work', 'job');
    await waitFor(() => taskRows(app).map((r) => r.title).join() === 'Work', 'the renamed tag still filtering');

    // Leaving saves every view's filter state: the old tag must not come back.
    await closeVault(app);
    expect(savedFilter(app, rel)).toEqual(['job']);
  });
});
