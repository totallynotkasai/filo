import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { UpdateCardFieldCommand } from '@renderer/commands/index';
import { makeFrontmatterWriter } from '@renderer/lib/tasklist/frontmatterWriter';
import { __resetDirtyTrackingForTests, hasFailedWrites } from '@renderer/lib/boards/writeStateTracking';
import type {
  TaskListBoard as TaskListBoardType,
  Tile,
} from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Silent-error honesty:
 *   - a field edit whose write fails is reported as failed (the save and quit
 *     drains see it), never as a silent success.
 *   - a Task field edit on a note the vault index doesn't know yet still
 *     reaches disk, as an undoable command.
 */

// ── a failed field write is surfaced, not silent ──────────────────────────────
describe('a card field edit whose write fails is reported as failed', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vault = installMemoryVault({ 'Card.md': '---\npriority: low\n---\nbody content\n' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vi.restoreAllMocks();
    restoreFiloDefault();
  });

  it('execute: the flush reports failure and the path is marked failed while disk stays stale', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    vault.failNextWrite('Card.md', 'ENOSPC');

    expect(await noteStore.flush('Card.md')).toBe(false);
    expect(hasFailedWrites()).toBe(true);
    expect(vault.read('Card.md')).toBe('---\npriority: low\n---\nbody content\n');
    // The change is kept, not dropped: a later save retries it.
    expect(noteStore.hasPendingWrites('Card.md')).toBe(true);
    expect(await noteStore.flush('Card.md')).toBe(true);
    expect(vault.read('Card.md')).toBe('---\npriority: high\n---\nbody content\n');
  });

  it('undo: a failed inverse write is reported the same way', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flush('Card.md');
    expect(vault.read('Card.md')).toBe('---\npriority: high\n---\nbody content\n');

    await cmd.undo();
    vault.failNextWrite('Card.md', 'ENOSPC');
    expect(await noteStore.flush('Card.md')).toBe(false);
    expect(hasFailedWrites()).toBe(true);
    expect(vault.read('Card.md')).toBe('---\npriority: high\n---\nbody content\n');
  });
});

// ── a field edit on an un-indexed note still persists ─────────────────────────
describe('Task field edit on a note missing from the index reaches disk, undoably', () => {
  let vault: MemoryVault;

  function makeWriter() {
    return makeFrontmatterWriter({
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
        }) as unknown as TaskListBoardType,
      vaultPathForTile: () => 'Orphan.md',
      // Construction-time inverse placeholder; the command recomputes from disk.
      readFrontmatter: () => ({}),
      bumpCacheVersion: () => {},
    });
  }

  function makeRow(): TaskRow {
    return {
      placement: { tileId: 't1', position: 0 },
      tile: { id: 't1', type: 'text', filePath: 'Orphan.md', title: 'Orphan', tags: [] } as unknown as Tile,
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
    };
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    // The `.md` EXISTS on disk but is ABSENT from the vault index.
    vaultIndexStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard('tl');
    vault = installMemoryVault({ 'Orphan.md': '---\ncompleted: false\n---\ntask body\n' });
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

  it('persists the field edit to disk', async () => {
    const writer = makeWriter();
    await writer.updateRowField(makeRow(), { completed: true });
    await noteStore.flushAll();
    expect(vault.read('Orphan.md')).toBe('---\ncompleted: true\n---\ntask body\n');
  });

  it('is undoable, and undo restores the value that was on disk', async () => {
    const writer = makeWriter();
    await writer.updateRowField(makeRow(), { completed: true });
    expect(historyStore.canUndo).toBe(true);
    await noteStore.flushAll();

    await historyStore.undo();
    await noteStore.flushAll();
    expect(vault.read('Orphan.md')).toBe('---\ncompleted: false\n---\ntask body\n');
  });
});
