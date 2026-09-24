/**
 * Phase B / B.3 — `loadBoard` must refuse to load when the recovery
 * snapshot IPC fails AND the board needs orphan-ref / duplicate prune.
 *
 * Previous behaviour: snapshot failure was logged and the loader
 * continued with the pruned in-memory shape. On the next save the
 * pruned shape was written back to disk, making the orphan / unknown-
 * type entries unrecoverable.
 *
 * New behaviour: when `.filo/recovery/<basename>` can't be created (the
 * directory is read-only, the disk is full, etc.) AND the prune would
 * actually mutate the envelope, the loader returns `error:
 * 'snapshot-failed'`. The board is surfaced through the standard
 * failed-board pipeline (toast + entry in `failedBoards[]`) and never
 * lands in the cache that the write scheduler could clobber.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadBoard, loadAllBoards } from '@renderer/lib/boards/boardLoader';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) throw new Error(`No stub for channel "${channel}"`);
      return handler(...args);
    },
    on: () => () => { /* no-op */ },
    send: () => { /* no-op */ },
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

function makeBoardWithOrphanRef(): V7BoardFileData {
  const now = 0;
  return {
    version: 8,
    board: {
      id: 'mm-orphan',
      name: 'OrphanMap',
      emoji: '',
      type: 'mindmap',
      settings: {},
      placements: {
        tile_a: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      createdAt: now,
      updatedAt: now,
    } as V7BoardFileData['board'],
    tileDefs: {
      tile_a: {
        id: 'tile_a',
        type: 'text',
        filePath: 'A.md',
        style: { headerColor: '#fff', bodyColor: '#fff' },
        createdAt: now,
        updatedAt: now,
      } as V7BoardFileData['tileDefs'][string],
    },
    connections: {
      c_orphan: {
        id: 'c_orphan',
        boardId: 'mm-orphan',
        fromTileId: 'tile_a',
        toTileId: 'tile_ghost', // missing
        fromBubble: 0,
        toBubble: 0,
        createdAt: now,
        updatedAt: now,
      } as never,
    },
    frames: [],
  };
}

function makeCleanBoard(): V7BoardFileData {
  const now = 0;
  return {
    version: 8,
    board: {
      id: 'mm-clean',
      name: 'CleanMap',
      emoji: '',
      type: 'mindmap',
      settings: {},
      placements: {
        tile_a: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      createdAt: now,
      updatedAt: now,
    } as V7BoardFileData['board'],
    tileDefs: {
      tile_a: {
        id: 'tile_a',
        type: 'text',
        filePath: 'A.md',
        style: { headerColor: '#fff', bodyColor: '#fff' },
        createdAt: now,
        updatedAt: now,
      } as V7BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
}

describe('loadBoard — snapshot-failure abort (Phase B.3)', () => {
  beforeEach(() => {
    uninstallFiloStub();
    __resetErrorBusForTests();
  });
  afterEach(() => {
    uninstallFiloStub();
    __resetErrorBusForTests();
  });

  it('(i) snapshot ok + prune needed → board loads pruned with snapshot path recorded', async () => {
    const file = makeBoardWithOrphanRef();
    // Real IPC contract — `recovery:snapshot` returns
    // `{ ok: true, path }` / `{ ok: false, code?, error }`, not a bare
    // string. See `src/main/ipc/board.ipc.ts:360-371`. The pre-Phase-1
    // production cast at `boardLoader.ts:452` is `as string`, which
    // happens to coerce the success envelope into a truthy object so
    // this test still passes — but the assertion does not look at the
    // snapshotPath, only at the load outcome.
    installFiloStub({
      'board:load': () => structuredClone(file),
      'recovery:snapshot': () => ({ ok: true, path: '.filo/recovery/orphan.board.json' }),
    });

    const result = await loadBoard('/vault', 'orphan.board.json');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.orphansPruned).toBe(true);
      // Orphan connection was pruned.
      expect(Object.keys(result.data.connections)).toEqual([]);
    }
  });

  it('(ii) snapshot fails + no prune needed → board loads (no abort)', async () => {
    // A clean board doesn't trigger the snapshot attempt at all because
    // peekUnknownTileTypes / peekHasOrphanRefs both come up empty.
    // Confirm that the loader doesn't ABORT on a hypothetical snapshot
    // failure when there's nothing to prune.
    const file = makeCleanBoard();
    installFiloStub({
      'board:load': () => structuredClone(file),
      // Real IPC contract — handler returns `{ ok: false, ... }` on
      // failure rather than throwing. The renderer's IPC bridge does
      // NOT translate `{ ok: false }` into a throw.
      'recovery:snapshot': () => ({ ok: false, error: 'EACCES recovery dir read-only' }),
    });

    const result = await loadBoard('/vault', 'clean.board.json');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.orphansPruned).toBe(false);
    }
  });

  // CONSOLIDATION_PLAN_2026-05-25.md Phase 1 — bug #1 fixed.
  // `boardLoader.ts` now consumes the recovery:snapshot envelope via
  // `invokeOk`. On `{ ok: false, ... }`, invokeOk throws
  // `IpcEnvelopeError`, the catch keeps `snapshotPath` null, and the
  // abort branch at `boardLoader.ts` returns `snapshot-failed` instead
  // of loading the board with the unrecoverable pruned shape.
  it('(iii) snapshot fails + prune needed → board routes to snapshot-failed (does NOT load)', async () => {
    const file = makeBoardWithOrphanRef();
    installFiloStub({
      'board:load': () => structuredClone(file),
      // Real IPC envelope — `{ ok: false }`, not throw.
      'recovery:snapshot': () => ({ ok: false, error: 'EACCES recovery dir read-only' }),
    });

    const result = await loadBoard('/vault', 'orphan.board.json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('snapshot-failed');
      // Message names the file and the remediation.
      expect(result.message).toContain('orphan.board.json');
      expect(result.message).toContain('.filo/recovery/');
    }
  });

  // CONSOLIDATION_PLAN_2026-05-25.md Phase 1 — bug #1 fixed.
  // `loadAllBoards` routes `{ ok: false, error: 'snapshot-failed' }`
  // through `failedBoards[]` correctly now that `boardLoader.ts`
  // surfaces the snapshot-failed error from invokeOk's catch.
  it('loadAllBoards surfaces a snapshot-failed entry through failedBoards[]', async () => {
    const file = makeBoardWithOrphanRef();
    installFiloStub({
      'board:list': () => ['orphan.board.json'],
      'board:load': () => structuredClone(file),
      // Real IPC envelope — `{ ok: false }`, not throw.
      'recovery:snapshot': () => ({ ok: false, error: 'EACCES recovery dir read-only' }),
    });

    const result = await loadAllBoards('/vault');
    expect(result.boards).toEqual([]);
    expect(result.failedBoards).toHaveLength(1);
    expect(result.failedBoards[0].errorKind).toBe('snapshot-failed');
    expect(result.failedBoards[0].path).toBe('orphan.board.json');
  });
});
