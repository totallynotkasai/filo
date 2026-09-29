import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { makeFrontmatterWriter, completionPatchForRow } from '@renderer/lib/tasklist/frontmatterWriter';
import { nextDueDate } from '@renderer/lib/tasks/recurrence';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { TaskListBoard as TaskListBoardType, Tile } from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A Task List row can show before its note's fields arrive (a large vault is
 * still being read at open): its recurrence is blank. Ticking it must still
 * roll a recurring task forward, never complete it for good, because the
 * completion is decided from the note as it stands, not from the row.
 */

const DUE = '2026-10-05';
const NOTE = `---\ncompleted: false\ndueDate: ${DUE}\nrecurrence: weekly\n---\ntask body\n`;

function makeWriter() {
  return makeFrontmatterWriter({
    getBoard: () =>
      ({ id: 'tl', type: 'tasklist', name: 'T', emoji: '', createdAt: 0, updatedAt: 0, settings: {}, tasks: [], sections: [] }) as unknown as TaskListBoardType,
    vaultPathForTile: () => 'Weekly.md',
    // The index hasn't read the note yet.
    readFrontmatter: () => ({}),
    bumpCacheVersion: () => {},
  });
}

/** The row as shown before the note's fields arrived: blanks. */
function blankRow(): TaskRow {
  return {
    placement: { tileId: 't1', position: 0 },
    tile: { id: 't1', type: 'text', filePath: 'Weekly.md', title: 'Weekly', tags: [] } as unknown as Tile,
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
    fieldsPending: true,
  };
}

describe('completing a recurring task decides from the note, not the row', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard('tl');
    vault = installMemoryVault({ 'Weekly.md': NOTE });
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard(null);
    restoreFiloDefault();
  });

  it('the row alone would complete it for good (why the note decides)', () => {
    expect(completionPatchForRow(blankRow())).toEqual({ completed: true });
  });

  it('ticking the blank row rolls the task forward on disk', async () => {
    await makeWriter().toggleCompleted(blankRow());
    await noteStore.flushAll();
    const next = nextDueDate(DUE, 'weekly', 'schedule', new Date());
    expect(next).toBeTruthy();
    expect(vault.read('Weekly.md')).toBe(`---\ncompleted: false\ndueDate: ${next}\nrecurrence: weekly\n---\ntask body\n`);
  });

  it('undo puts the due date back', async () => {
    await makeWriter().toggleCompleted(blankRow());
    await noteStore.flushAll();
    await historyStore.undo();
    await noteStore.flushAll();
    expect(vault.read('Weekly.md')).toBe(NOTE);
  });

  it('the bulk path (buildTaskFieldCommand) decides the same way', async () => {
    const writer = makeWriter();
    const cmd = writer.buildTaskFieldCommand(blankRow(), completionPatchForRow(blankRow()), 'Mark 1 tasks complete');
    expect(cmd).not.toBeNull();
    if (!cmd) return;
    await historyStore.execute(cmd);
    await noteStore.flushAll();
    expect(vault.read('Weekly.md')).not.toContain('completed: true');
    expect(vault.read('Weekly.md')).not.toContain(`dueDate: ${DUE}`);
  });

  it('a task that doesn\'t recur is completed as before', async () => {
    vault = installMemoryVault({ 'Weekly.md': '---\ncompleted: false\n---\nbody\n' });
    await makeWriter().toggleCompleted(blankRow());
    await noteStore.flushAll();
    expect(vault.read('Weekly.md')).toBe('---\ncompleted: true\n---\nbody\n');
  });
});
