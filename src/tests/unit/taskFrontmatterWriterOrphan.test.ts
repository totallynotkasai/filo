import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeFrontmatterWriter,
  type FrontmatterWriter,
} from '@renderer/lib/tasklist/frontmatterWriter';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import type { Tile, TaskListBoard } from '@renderer/schema/index';

/**
 * Task List frontmatter-writer contracts:
 *   - markAllIncomplete counts only the rows it actually changes. A text tile
 *     with no `filePath` (a hand-edited / legacy `.board.json`) has no note,
 *     so it gets no command and isn't counted.
 *   - The notes box writes the typed body, never re-emits the old disk body,
 *     and keeps the frontmatter.
 *   - Clearing a due date clears its time in one command.
 *   - A recurring roll-forward announces the new date.
 */

function mkRow(over: Partial<TaskRow> & { id: string }): TaskRow {
  const { id, ...rest } = over;
  return {
    placement: { tileId: id, position: 0 },
    tile: { id, type: 'text', title: id } as unknown as Tile,
    completed: false,
    priority: 'none',
    dueDate: '',
    dueTime: '',
    startDate: '',
    status: '',
    tags: [],
    parent: '',
    recurrence: '',
    recurrenceMode: 'schedule',
    category: '',
    ...rest,
  } as TaskRow;
}

function makeWriter(): FrontmatterWriter {
  return makeFrontmatterWriter({
    getBoard: () => ({ id: 'b' } as unknown as TaskListBoard),
    vaultPathForTile: (tile) => `${tile.title}.md`,
    readFrontmatter: () => ({ completed: true }),
    bumpCacheVersion: () => {},
  });
}

describe('markAllIncomplete counts only rows with a note', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds a command for the row with a note and counts it honestly', async () => {
    const executeSpy = vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const toastSpy = vi.spyOn(uiStore, 'toast');
    const writer = makeWriter();

    const noteRow = mkRow({
      id: 'withDoc',
      completed: true,
      tile: { id: 'withDoc', type: 'text', title: 'WithDoc', filePath: 'WithDoc.md' } as unknown as Tile,
    });
    const pathlessRow = mkRow({ id: 'pathless', completed: true }); // no filePath

    await writer.markAllIncomplete([noteRow, pathlessRow]);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith('1 task marked incomplete', 'success', 2000);
  });

  it('toasts "no completed tasks" when none are completed', async () => {
    const toastSpy = vi.spyOn(uiStore, 'toast');
    const writer = makeWriter();
    await writer.markAllIncomplete([mkRow({ id: 'a', completed: false })]);
    expect(toastSpy).toHaveBeenCalledWith('No completed tasks to mark', 'info', 2000);
  });
});

describe('setNotesBody writes the typed body', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({ 'Task.md': '---\ncompleted: false\n---\nOLD BODY\n' });
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
  });

  it('writes the NEW note body (not the re-emitted old disk body), FM preserved', async () => {
    const writer = makeWriter();
    const row = mkRow({
      id: 't',
      tile: { id: 't', type: 'text', title: 'Task', filePath: 'Task.md' } as unknown as Tile,
    });

    await writer.setNotesBody(row, 'NEW NOTE BODY');
    await noteStore.flushAll();

    const content = vault.read('Task.md') ?? '';
    expect(content).toContain('NEW NOTE BODY');
    expect(content).not.toContain('OLD BODY');
    expect(content).toContain('completed: false');
  });

  it('a row with no note writes nothing', async () => {
    const writer = makeWriter();
    await writer.setNotesBody(mkRow({ id: 'pathless' }), 'typed');
    await noteStore.flushAll();
    expect(vault.writes).toEqual([]);
  });
});
describe('clearing a due date clears its time in ONE command', () => {
  afterEach(() => vi.restoreAllMocks());

  function dateWriter(): FrontmatterWriter {
    return makeFrontmatterWriter({
      getBoard: () => ({ id: 'b' } as unknown as TaskListBoard),
      vaultPathForTile: (tile) => `${tile.title}.md`,
      readFrontmatter: () => ({ dueDate: '2026-01-01', dueTime: '09:00' }),
      bumpCacheVersion: () => {},
    });
  }

  // The command's default description is `Update task <keys>` — a cheap, public
  // proxy for the patch shape (the patch field is private).
  function descOf(spy: ReturnType<typeof vi.spyOn>): string {
    const cmd = spy.mock.calls[0]?.[0] as { description: string } | undefined;
    return cmd?.description ?? '';
  }

  it('emits a single {dueDate, dueTime} patch when the row has a time', async () => {
    const executeSpy = vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const row = mkRow({
      id: 'r',
      dueDate: '2026-01-01',
      dueTime: '09:00',
      tile: { id: 'r', type: 'text', title: 'R', filePath: 'R.md' } as unknown as Tile,
    });
    await dateWriter().setDueDate(row, '');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(descOf(executeSpy)).toBe('Update task dueDate, dueTime');
  });

  it('emits a single {dueDate} patch when the row has no time', async () => {
    const executeSpy = vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const row = mkRow({
      id: 'r',
      dueDate: '2026-01-01',
      dueTime: '',
      tile: { id: 'r', type: 'text', title: 'R', filePath: 'R.md' } as unknown as Tile,
    });
    await dateWriter().setDueDate(row, '');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(descOf(executeSpy)).toBe('Update task dueDate');
  });

  it('a non-empty date leaves the time untouched (single-key patch)', async () => {
    const executeSpy = vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const row = mkRow({
      id: 'r',
      dueDate: '',
      dueTime: '09:00',
      tile: { id: 'r', type: 'text', title: 'R', filePath: 'R.md' } as unknown as Tile,
    });
    await dateWriter().setDueDate(row, '2026-02-02');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(descOf(executeSpy)).toBe('Update task dueDate');
  });
});

describe('recurring roll-forward announces the new date', () => {
  afterEach(() => vi.restoreAllMocks());

  function writer(): FrontmatterWriter {
    return makeFrontmatterWriter({
      getBoard: () => ({ id: 'b' } as unknown as TaskListBoard),
      vaultPathForTile: (tile) => `${tile.title}.md`,
      readFrontmatter: () => ({}),
      bumpCacheVersion: () => {},
    });
  }

  it('toasts "rescheduled" when completing a recurring task rolls it forward', async () => {
    vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const toastSpy = vi.spyOn(uiStore, 'toast');
    const row = mkRow({
      id: 'r',
      recurrence: 'weekly',
      recurrenceMode: 'completion',
      dueDate: '2026-01-01',
      tile: { id: 'r', type: 'text', title: 'R', filePath: 'R.md' } as unknown as Tile,
    });
    await writer().toggleCompleted(row);
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('rescheduled'), 'info', 2500);
  });

  it('does NOT toast when completing a plain (non-recurring) task', async () => {
    vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const toastSpy = vi.spyOn(uiStore, 'toast');
    const row = mkRow({
      id: 'r',
      tile: { id: 'r', type: 'text', title: 'R', filePath: 'R.md' } as unknown as Tile,
    });
    await writer().toggleCompleted(row);
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
