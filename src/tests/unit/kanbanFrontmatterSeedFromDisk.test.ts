import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { makeKanbanFrontmatterWriter } from '@renderer/lib/kanban/kanbanFrontmatterWriter';
import { makeFrontmatterWriter } from '@renderer/lib/tasklist/frontmatterWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { historyStore } from '@renderer/stores/history.svelte';
import type {
  KanbanBoard as KanbanBoardType,
  TaskListBoard as TaskListBoardType,
  Tile,
} from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';

/**
 * A Kanban card / Task row field edit on a note no view holds must land on the
 * file as it is on disk, not on the (possibly stale) vault index: a key another
 * program added since the last index rebuild must survive, the body must stay
 * intact, and a missing file must fail loudly instead of reporting "Saved".
 */

const CARD = '---\npriority: high\ncompleted: false\n---\ncard body';
const TASK = '---\npriority: high\ncompleted: false\n---\ntask body';

/** The index never learned about the externally-added `priority: high`. */
function staleIndex(path: string, body: string): void {
  vaultIndexStore.restoreMetadata(path, {
    path,
    title: path.replace(/\.md$/, ''),
    headings: [],
    tags: [],
    frontmatter: { completed: false },
    links: [],
    content: body,
    lastModified: 0,
    rawFrontmatter: 'completed: false',
  });
}

function makeKanbanWriter() {
  const tile = { id: 't1', type: 'text', title: 'Card', tags: [], filePath: 'Card.md' } as unknown as Tile;
  return makeKanbanFrontmatterWriter({
    getBoard: () => ({ id: 'kb', type: 'kanban', columns: [] }) as unknown as KanbanBoardType,
    getAllTilesById: () => ({ t1: tile }),
    bumpCacheVersion: () => {},
    tickAndPersist: () => {},
  });
}

function resetAll(): void {
  noteStore.__resetForTests();
  boardCacheStore.clear();
  vaultIndexStore.clear();
}

describe('Kanban field edit lands on the disk frontmatter, not the stale index', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    resetAll();
    vault = installMemoryVault({ 'Card.md': CARD });
    staleIndex('Card.md', 'card body');
  });

  afterEach(() => {
    resetAll();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('with no view holding the note, the write keeps the external key and the body', async () => {
    expect(noteStore.get('Card.md')).toBeUndefined();

    await makeKanbanWriter().updateTileFrontmatter('t1', { completed: true });
    expect((await noteStore.flushAll()).failed).toEqual([]);

    const written = vault.read('Card.md') ?? '';
    expect(written).toContain('completed: true'); // the user's edit reached disk
    expect(written).toContain('priority: high'); // external key preserved
    expect(written).toContain('card body'); // body intact
    // The write refreshes the stale index from the bytes it wrote.
    expect(vaultIndexStore.getMetadata('Card.md')?.frontmatter).toMatchObject({ priority: 'high', completed: true });
  });

  it('with the note open in a view, the write keeps the external key end-to-end', async () => {
    const m = noteStore.acquire('Card.md', 'doc');
    await m.loaded;

    await makeKanbanWriter().updateTileFrontmatter('t1', { completed: true });
    expect(m.frontmatter).toMatchObject({ priority: 'high', completed: true });
    await noteStore.flushAll();

    const written = vault.read('Card.md') ?? '';
    expect(written).toContain('priority: high');
    expect(written).toContain('completed: true');
    expect(written).toContain('card body');
  });

  it('a missing backing file surfaces the loss in flushAll().failed (no false "Saved")', async () => {
    vault.remove('Card.md');

    await makeKanbanWriter().updateTileFrontmatter('t1', { completed: true });

    const result = await noteStore.flushAll();
    expect(result.failed).toContain('Card.md');
    // Nothing was written, and the file was not recreated.
    expect(vault.writes.filter(([, rel]) => rel.endsWith('.md'))).toHaveLength(0);
    expect(vault.read('Card.md')).toBeUndefined();
  });
});

/**
 * The field command reads the note before it queues the change. A Ctrl+S or
 * quit landing in that read must not see an empty command chain and report
 * "Saved" early: `vaultStore.save()` and the quit path await
 * `historyStore.whenChainSettled()` before flushing, so the read must keep the
 * chain in flight.
 */
describe('Kanban field edit — whenChainSettled covers the in-flight read', () => {
  let written: string[];
  let releaseRead: () => void;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    resetAll();
    written = [];
    let disk = CARD;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        await readGate;
        return { success: true, content: disk, mtimeMs: 7, size: disk.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 7, size: disk.length };
      if (channel === 'vault:write-existing-file-text') {
        disk = String(args[2]);
        written.push(disk);
        return { success: true };
      }
      return { success: true };
    });
    staleIndex('Card.md', 'card body');
  });

  afterEach(() => {
    releaseRead();
    resetAll();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('whenChainSettled() stays pending while the read is in flight', async () => {
    // Fire the edit WITHOUT awaiting (mirrors a UI click). The command is on
    // the history chain, suspended at its gated read.
    const editP = makeKanbanWriter().updateTileFrontmatter('t1', { completed: true });

    let chainSettled = false;
    const chainP = historyStore.whenChainSettled().then(() => {
      chainSettled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(chainSettled).toBe(false);

    // Release the read: the change is queued, the chain settles, and (as
    // save() does next) the write flushes to disk.
    releaseRead();
    await chainP;
    await editP;
    expect(chainSettled).toBe(true);

    await noteStore.flushAll();
    const last = written.at(-1);
    expect(last, 'no markdown write captured after the chain settled').toBeDefined();
    expect(last).toContain('completed: true'); // user's edit landed
    expect(last).toContain('priority: high'); // externally-added key survived
  });
});

describe('Un-opened Task row field edit reaches disk', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    resetAll();
    vault = installMemoryVault({ 'Task.md': TASK });
    staleIndex('Task.md', 'task body');
  });

  afterEach(() => {
    resetAll();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

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
      vaultPathForTile: () => 'Task.md',
      readFrontmatter: () => ({ completed: false }),
      bumpCacheVersion: () => {},
    });
  }

  function makeRow(): TaskRow {
    return {
      placement: { tileId: 't2', position: 0 },
      tile: { id: 't2', type: 'text', filePath: 'Task.md', title: 'Task', tags: [] } as unknown as Tile,
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

  it('toggling completed writes the merged frontmatter to disk with no Document tab open', async () => {
    expect(noteStore.get('Task.md')).toBeUndefined();

    await makeWriter().toggleCompleted(makeRow());
    expect((await noteStore.flushAll()).failed).toEqual([]);

    const written = vault.read('Task.md') ?? '';
    expect(written).toContain('completed: true'); // user's edit reached disk
    expect(written).toContain('priority: high'); // external key preserved
    expect(written).toContain('task body'); // body intact
  });
});
