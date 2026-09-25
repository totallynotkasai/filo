import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { UpdateTaskFieldCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard } from '@renderer/schema/index';

/**
 * UpdateTaskFieldCommand: a rapid Apply → Undo must end with the undo on
 * disk. Both legs queue on the note's one write queue, so the forward write
 * can never land after the inverse and overwrite it; the same holds for a
 * redo right behind the undo.
 */

function makeTaskListFixture(): V7BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'manual' },
      tasks: [],
    } as unknown as TaskListBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('UpdateTaskFieldCommand — apply and undo land in order', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    restoreFiloDefault();
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({ 'task.md': '---\nstatus: todo\n---\nTask body\n' });
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      { tl: makeTaskListFixture() },
      { tl: 'tasks.board.json' },
    );
  });
  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('an undo right behind the execute wins on disk', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { status: 'done' }, { status: 'todo' });

    await cmd.execute();
    expect(noteStore.frontmatter('task.md').status).toBe('done');
    await cmd.undo();
    await noteStore.flushAll();

    expect(vault.read('task.md')).toBe('---\nstatus: todo\n---\nTask body\n');
  });

  it('a forward write already in flight lands before the undo', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { status: 'done' }, { status: 'todo' });
    await cmd.execute();
    const forward = noteStore.flush('task.md');
    await cmd.undo();
    await forward;
    await noteStore.flushAll();

    const statusWrites = vault.writes
      .filter(([, rel]) => rel === 'task.md')
      .map(([, , text]) => /status: (\w+)/.exec(text)?.[1]);
    expect(statusWrites.at(-1)).toBe('todo');
    expect(vault.read('task.md')).toBe('---\nstatus: todo\n---\nTask body\n');

    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read('task.md')).toBe('---\nstatus: done\n---\nTask body\n');
  });

  it('execute and undo are async (return Promises)', () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'low' });
    const e = cmd.execute();
    const u = cmd.undo();
    expect(e).toBeInstanceOf(Promise);
    expect(u).toBeInstanceOf(Promise);
    return Promise.allSettled([e, u]);
  });
});
