import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import {
  AddTaskCommand,
  UpdateCardFieldCommand,
  UpdateTaskFieldCommand,
} from '@renderer/commands/index';
import { KanbanMultiSelect } from '@renderer/lib/kanban/kanbanMultiSelect.svelte';
import { createSelectionScope } from '@renderer/stores/selection.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import type {
  KanbanBoard as KanbanBoardType,
  TaskListBoard as TaskListBoardType,
  TaskPlacement,
  TileDefinition,
  Tile,
} from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-9 Phase 1 behavioral matrix:
 *   - A9-H1: a field command whose first read spans a vault swap writes nothing.
 *   - A9-M3: the seed thunk folded into AddTaskCommand.execute() (+ rollback).
 *   - A9-L1: the Kanban bulk tag-add is one undoable, chained BatchCommand.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function writesIn(captured: Captured[]): Captured[] {
  return captured.filter(
    (c) =>
      c.channel === 'vault:write-existing-file-text' ||
      c.channel === 'vault:write-file-text' ||
      c.channel === 'vault:create-file-text',
  );
}

// ── A9-H1 — cross-vault frontmatter write suppression ────────────────────────
describe('A9-H1 — first-touch field edit + vault swap mid-read never writes the old vault FM onto the new vault', () => {
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
        // Vault A's bytes.
        return gate.then(() => ({
          success: true,
          content: '---\ncompleted: false\npriority: high\n---\nbody A',
          mtimeMs: 5,
          size: 50,
          encoding: 'utf-8',
        }));
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: 50 };
      return { success: true };
    });
  }

  beforeEach(() => {
    __resetVaultIdentityForTests();
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
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
    noteStore.__resetForTests();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  it('Kanban UpdateCardFieldCommand bails — no cross-vault write, nothing queued for the note', async () => {
    installGatedMock();
    const cmd = new UpdateCardFieldCommand('kb', 'Inbox.md', { completed: true }, { completed: false });
    const execP = cmd.execute();
    // Suspended at the gated read; identity captured against vault A.
    await readReachedP;
    // File > Open Vault (B), nothing unsaved: the new vault generation commits.
    vaultStore.setPath('/vaultB');
    releaseRead();
    await execP;
    await noteStore.flushAll();

    expect(writesIn(captured)).toHaveLength(0);
    expect(noteStore.hasPendingWrites('Inbox.md')).toBe(false);
    expect(noteStore.frontmatter('Inbox.md').completed).toBeUndefined();
  });

  it('Task UpdateTaskFieldCommand bails — no cross-vault write, nothing queued for the note', async () => {
    installGatedMock();
    const cmd = new UpdateTaskFieldCommand('tl', 'Inbox.md', { completed: true }, { completed: false });
    const execP = cmd.execute();
    await readReachedP;
    vaultStore.setPath('/vaultB');
    releaseRead();
    await execP;
    await noteStore.flushAll();

    expect(writesIn(captured)).toHaveLength(0);
    expect(noteStore.hasPendingWrites('Inbox.md')).toBe(false);
    expect(noteStore.frontmatter('Inbox.md').completed).toBeUndefined();
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
      filePath: `${id}.md`,
      style: { headerColor: '', bodyColor: '' },
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
    vaultStore.setPath('/vault');
    installFiloMock(() => ({ success: true }));
    hydrateBoard();
    historyStore.clear();
    historyStore.setActiveBoard('tl');
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
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
    noteStore.__resetForTests();
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
    noteStore.__resetForTests();
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
      a: { id: 'a', type: 'text', filePath: 'a.md', title: 'A', tags: [] } as unknown as Tile,
      b: { id: 'b', type: 'text', filePath: 'b.md', title: 'B', tags: [] } as unknown as Tile,
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
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', '---\ntags: [urgent]\n---\n'));
    vaultIndexStore.restoreMetadata('b.md', parseMarkdown('b.md', '---\ntags: [urgent]\n---\n'));
    const selection = createSelectionScope();
    selection.addMultiple(['a', 'b']);
    const ms = makeMultiSelect(selection, 'urgent');
    const execSpy = vi.spyOn(historyStore, 'execute').mockImplementation(async () => {});

    await ms.tagSelectedTiles();
    execSpy.mockRestore();

    expect(execSpy).not.toHaveBeenCalled();
  });
});
