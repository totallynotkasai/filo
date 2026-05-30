/**
 * Audit 5.2 — `deleteAllCompleted` reads the live rows projection, not the
 * 300ms-debounced vault index.
 *
 * The bulk "delete completed" path used to read `completed` straight from
 * `vaultIndexStore`, which lags behind a just-checked task (documentStore is
 * updated synchronously by `toggleCompleted`; the index only catches up after
 * the debounce → disk write → fs.watch round-trip). Checking a task off and
 * immediately bulk-deleting could therefore silently skip it.
 *
 * The fix derives the completed set from the already-computed `rows`, whose
 * `completed` flag is read documentStore-first. These tests inject a `getRows`
 * that reports the live state and assert the selection follows it — a direct
 * vault-index read would have found zero completed tasks in the first case.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTaskDeleter } from '@renderer/lib/tasklist/taskDeletion';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import type { TaskListBoard, Tile } from '@renderer/schema/index';
import { restoreFiloDefault } from '../helpers/filoBridge';

function mkRow(tileId: string, completed: boolean): TaskRow {
  return {
    placement: { tileId, position: 0 },
    tile: { id: tileId } as unknown as Tile,
    completed,
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
  };
}

function makeDeleter(rows: TaskRow[]) {
  return makeTaskDeleter({
    getBoard: () =>
      ({
        id: 'tl',
        type: 'tasklist',
        name: 'T',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        tasks: [],
        sections: [],
      }) as unknown as TaskListBoard,
    getRows: () => rows,
    getTilesById: () => ({}),
    buildTaskFieldCommand: () => null,
    tickAndPersist: () => {},
    announce: () => {},
  });
}

describe('Audit 5.2 — deleteAllCompleted reads live rows, not the stale index', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;
  let toastSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    confirmSpy = vi.spyOn(uiStore, 'openConfirm');
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    confirmSpy.mockRestore();
    toastSpy.mockRestore();
    uiStore.closeConfirm();
    restoreFiloDefault();
  });

  it('selects the completed set from the (documentStore-backed) rows projection', () => {
    const rows = [mkRow('done-1', true), mkRow('pending', false), mkRow('done-2', true)];
    makeDeleter(rows).deleteAllCompleted();

    expect(toastSpy).not.toHaveBeenCalled();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const cfg = confirmSpy.mock.calls[0][0] as { title: string; body: string };
    expect(cfg.title).toBe('Delete completed tasks');
    expect(cfg.body).toContain('2 completed task');
  });

  it('toasts and does not confirm when no row is completed', () => {
    makeDeleter([mkRow('a', false), mkRow('b', false)]).deleteAllCompleted();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(String(toastSpy.mock.calls[0][0])).toContain('No completed tasks');
  });
});
