import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import {
  AddTaskCommand,
  UpdateCardFieldCommand,
  UpdateTaskFieldCommand,
} from '@renderer/commands/index';
import { makeFrontmatterWriter } from '@renderer/lib/tasklist/frontmatterWriter';
import { KanbanMultiSelect } from '@renderer/lib/kanban/kanbanMultiSelect.svelte';
import { createSelectionScope } from '@renderer/stores/selection.svelte';
import { flushAllPendingFrontmatterWrites } from '@renderer/lib/boards/frontmatterWriteScheduler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import type {
  KanbanBoard as KanbanBoardType,
  TaskListBoard as TaskListBoardType,
  TaskPlacement,
  TileDefinition,
  Tile,
} from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-9 Phase 1 behavioral matrix. Each test reds when its fix is
 * temp-reverted (the A8 discipline):
 *   - A9-H1: the field command's `isStillSameVault` bail across the seed await.
 *   - A9-M2: the synchronous index placeholder before the early arm.
 *   - A9-M3: the seed thunk folded into AddTaskCommand.execute() (+ rollback).
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function writesIn(captured: Captured[]): Captured[] {
  return captured.filter(
    (c) =>
      c.channel === 'vault:write-existing-file-text' ||
      c.channel === 'vault:write-file-text',
  );
}

function lastExistingWrite(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string;
    }
  }
  return undefined;
}

// ── A9-H1 — cross-vault frontmatter write suppression ────────────────────────
describe('A9-H1 — first-touch field edit + vault swap mid-seed never writes the old vault FM onto the new vault', () => {
  let captured: Captured[];
  let releaseRead: () => void;
  let readReachedP: Promise<void>;

  function installGatedMock() {
    let readReached!: () => void;
    readReachedP = new Promise<void>((r) => {
      readReached = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    releaseRead = release;
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        readReached();
        // Vault A's bytes, captured against vaultStore.path at call time.
        return gate.then(() => ({
          success: true,
          content: '---\ncompleted: false\npriority: high\n---\nbody A',
          mtimeMs: 5,
          size: 50,
        }));
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: 50 };
      return { success: true };
    });
  }

  beforeEach(() => {
    __resetVaultIdentityForTests();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vaultA');
    captured = [];
  });
  afterEach(() => {
    releaseRead?.();
    restoreFiloDefault();
    __resetVaultIdentityForTests();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  it('Kanban UpdateCardFieldCommand bails — no cross-vault write, no docA FM entry', async () => {
    installGatedMock();
    const cmd = new UpdateCardFieldCommand(
      'kb',
      'Inbox.md',
      'docA',
      { completed: true },
      { completed: false },
    );
    const execP = cmd.execute();
    // Suspended at the seed's gated read; identity captured against vault A.
    await readReachedP;
    // File > Open Vault (B) → "Don't Save": clear the doc store + commit the new
    // vault generation, exactly as the pre-swap handler + commitVaultCandidate do.
    documentStore.clear('/vaultB');
    vaultStore.setPath('/vaultB');
    releaseRead();
    await execP;
    await flushAllPendingFrontmatterWrites();

    expect(writesIn(captured)).toHaveLength(0);
    expect(documentStore.getFrontmatter('docA')).toBeUndefined();
  });

  it('Task UpdateTaskFieldCommand bails — no cross-vault write, no docB FM entry', async () => {
    installGatedMock();
    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'Inbox.md',
      'docB',
      { completed: true },
      { completed: false },
    );
    const execP = cmd.execute();
    await readReachedP;
    documentStore.clear('/vaultB');
    vaultStore.setPath('/vaultB');
    releaseRead();
    await execP;
    await flushAllPendingFrontmatterWrites();

    expect(writesIn(captured)).toHaveLength(0);
    expect(documentStore.getFrontmatter('docB')).toBeUndefined();
  });
});

// ── A9-M2 — notes-body edit survives a quit-flush during the FM seed ──────────
describe('A9-M2 — Task notes body is not lost when a quit flush lands during the FM seed', () => {
  let captured: Captured[];
  let releaseRead: () => void;
  let readCount: number;

  beforeEach(() => {
    __resetVaultIdentityForTests();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    readCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    releaseRead = release;
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        readCount++;
        // Gate ONLY the first read — the setNotesBody refresh seed — so it is
        // still in flight when flushAll fires the early-armed write.
        if (readCount === 1) await gate;
        return {
          success: true,
          content: '---\ncompleted: false\n---\ntask body',
          mtimeMs: 7,
          size: 40,
        };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 7, size: 40 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
    vaultIndexStore.restoreMetadata('Task.md', {
      path: 'Task.md',
      title: 'Task',
      headings: [],
      tags: [],
      frontmatter: { completed: false },
      links: [],
      content: 'task body',
      lastModified: 0,
    });
  });
  afterEach(() => {
    releaseRead?.();
    restoreFiloDefault();
    __resetVaultIdentityForTests();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
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
      tile: { id: 't2', type: 'text', contentId: 'doc2', title: 'Task', tags: [] } as unknown as Tile,
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

  it('the early-armed write carries the typed body even though the FM seed is still in flight', async () => {
    const writer = makeWriter();
    const p = writer.setNotesBody(makeRow(), 'typed notes here');
    // Let setNotesBody reach (and gate on) the refresh seed's disk read (#1).
    await vi.waitFor(() => expect(readCount).toBe(1));
    // A quit drains the pending writes WHILE the seed read is still suspended.
    await flushAllPendingFrontmatterWrites();

    const written = lastExistingWrite(captured);
    expect(written, 'early-armed write must not no-op on empty FM (A9-M2)').toBeDefined();
    expect(written).toContain('typed notes here'); // body persisted
    expect(written).toContain('completed: false'); // placeholder FM seeded synchronously

    // cleanup — release the gated seed so setNotesBody finishes.
    releaseRead();
    await p;
  });
});

// ── A9-M3 — task-creation .md seed runs on the history chain ──────────────────
describe('A9-M3 — backing-.md seed runs inside the chained AddTaskCommand', () => {
  function hydrateBoard() {
    boardCacheStore.clear();
    boardCacheStore.hydrate(
      {
        tl: {
          board: {
            id: 'tl',
            type: 'tasklist',
            name: 'Tasks',
            emoji: '',
            createdAt: 0,
            updatedAt: 0,
            settings: { groupBy: 'status', sortBy: 'manual' },
            sections: [{ id: 's1', title: 'A', position: 0, collapsed: false }],
            tasks: [],
          } as unknown as TaskListBoardType,
          tileDefs: {},
          connections: {},
          frames: [],
        },
      },
      { tl: 'tasks.board.json' },
    );
  }

  function newDef(id: string): TileDefinition {
    return {
      id,
      type: 'text',
      title: id,
      style: { headerColor: '', bodyColor: '' },
      tags: [],
      contentId: `doc_${id}`,
      content: '',
      createdAt: 0,
      updatedAt: 0,
    } as unknown as TileDefinition;
  }

  function placement(tileId: string): TaskPlacement | undefined {
    const tl = boardCacheStore.cache.tl?.board as TaskListBoardType | undefined;
    return ((tl?.tasks ?? []) as TaskPlacement[]).find((p) => p.tileId === tileId);
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    vaultStore.setPath('/vault');
    installFiloMock(() => ({ success: true }));
    hydrateBoard();
    historyStore.clear();
    historyStore.setActiveBoard('tl');
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    boardCacheStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard(null);
    vaultStore.setPath('');
  });

  it('whenChainSettled() stays pending until the backing-.md seed resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cmd = new AddTaskCommand('tl', newDef('tNew'), 0, undefined, undefined, async () => {
      await gate;
    });
    const execP = historyStore.execute(cmd);
    // Placement persisted synchronously (before the seed await).
    expect(placement('tNew')).toBeDefined();

    let settled = false;
    void historyStore.whenChainSettled().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    // The seed thunk is gated → the chain that save()/quit await is still in flight.
    expect(settled).toBe(false);

    release();
    await execP;
    await historyStore.whenChainSettled();
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(true);
  });

  it('rolls the placement back when the backing-.md seed write fails (no orphan row)', async () => {
    const cmd = new AddTaskCommand('tl', newDef('tBad'), 0, undefined, undefined, async () => {
      throw new Error('ENOSPC');
    });
    await historyStore.execute(cmd).catch(() => {});

    // Placement rolled back — no orphan row referencing a missing `.md`.
    expect(placement('tBad')).toBeUndefined();
    // The failed command was removed from the undo stack by historyStore's rollback.
    expect(historyStore.canUndo).toBe(false);
  });
});

// ── A9-L1 — Kanban bulk tag-add is undoable + crash-safe ──────────────────────
describe('A9-L1 — Kanban bulk tag-add routes through an undoable, chained BatchCommand', () => {
  beforeEach(() => {
    __resetVaultIdentityForTests();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    historyStore.clear();
    historyStore.setActiveBoard('kb');
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ncompleted: false\n---\nbody', mtimeMs: 1, size: 20 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 20 };
      return { success: true };
    });
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetVaultIdentityForTests();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard(null);
    vaultStore.setPath('');
  });

  // Audit-18 M7 — the bulk tag value is injected via `promptForTag` (an in-app
  // popup resolver) rather than `window.prompt`, which throws in Electron's
  // renderer. The test supplies the resolver directly.
  function makeMultiSelect(
    selection: ReturnType<typeof createSelectionScope>,
    promptValue: string | null = 'urgent',
  ) {
    const tiles: Record<string, Tile> = {
      a: { id: 'a', type: 'text', contentId: 'docA', title: 'A', tags: [] } as unknown as Tile,
      b: { id: 'b', type: 'text', contentId: 'docB', title: 'B', tags: [] } as unknown as Tile,
    };
    return new KanbanMultiSelect({
      selection,
      getBoardId: () => 'kb',
      getColumns: () => [] as unknown as KanbanBoardType['columns'],
      getAllTilesById: () => tiles,
      getFlatVisibleTileIds: () => ['a', 'b'],
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
      ensureSeededFm: () => null,
      vaultPathForTile: (t: Tile) => `${t.id}.md`,
      promptForTag: () => Promise.resolve(promptValue),
    });
  }

  it('routes the bulk tag add through a single chained, undoable BatchCommand', async () => {
    const selection = createSelectionScope();
    selection.addMultiple(['a', 'b']);
    const ms = makeMultiSelect(selection, 'urgent');
    // Capture the command WITHOUT running the per-card write pipeline (the
    // children's on-chain seeds + gateway writes are exercised by the A9-H1 /
    // A9-M2 tests). The structural claim here is: one BatchCommand, dispatched
    // via historyStore.execute — i.e. on the history chain (crash-safe) AND on
    // the undo stack (undoable), unlike the old off-chain per-card loop.
    const dispatched: unknown[] = [];
    const execSpy = vi
      .spyOn(historyStore, 'execute')
      .mockImplementation(async (cmd) => {
        dispatched.push(cmd);
      });

    await ms.tagSelectedTiles();
    execSpy.mockRestore();

    expect(dispatched).toHaveLength(1);
    const batch = dispatched[0] as { constructor: { name: string }; description: string };
    expect(batch.constructor.name).toBe('BatchCommand');
    expect(batch.description).toContain('urgent');
  });

  it('does not dispatch a command (or toast success) when every card already has the tag', async () => {
    // Pre-seed both cards with the tag so the additive loop produces no commands.
    documentStore.setFrontmatter('docA', { tags: ['urgent'] });
    documentStore.setFrontmatter('docB', { tags: ['urgent'] });
    const selection = createSelectionScope();
    selection.addMultiple(['a', 'b']);
    const ms = makeMultiSelect(selection, 'urgent');
    const execSpy = vi.spyOn(historyStore, 'execute').mockImplementation(async () => {});

    await ms.tagSelectedTiles();
    execSpy.mockRestore();

    expect(execSpy).not.toHaveBeenCalled();
  });
});
