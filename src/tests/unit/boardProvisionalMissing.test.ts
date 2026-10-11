import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markBoardProvisionallyMissing,
  RECHECK_GRACE_MS,
} from '@renderer/stores/boardProvisionalMissing';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { captureVaultIdentity, beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import { isBoardPathHeld } from '@renderer/lib/boards/boardWriteScheduler';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { baselineSeq, noteBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';

/**
 * An external FOLDER rename on Windows emits no child events,
 * so an open board's file "vanished" and the tree refresh EVICTED it at once:
 * its pending edit was cancelled and its tabs closed, and the reconcile rename
 * that arrived seconds later had nothing to rebind. The board is now only
 * provisionally missing: its writes are held (not dropped) and re-fired to the
 * new path once the reconcile rename rebinds it.
 */

function makeBoard(id: string, name: string): BoardFileData {
  return {
    board: {
      id, type: 'mindmap', name, emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      placements: {}, inlineTiles: {}, waypoints: [],
    },
    tileDefs: {},
    connections: {},
    frames: [],
  } as unknown as BoardFileData;
}

const OLD = 'Projects/Plan.board.json';
const NEW = 'Work/Plan.board.json';

describe('provisionally missing boards', () => {
  let saves: string[];
  let recreates: string[];
  let onReconcile: () => void;
  let fileExists: boolean;
  const enqueue = (task: () => Promise<void>): Promise<unknown> => task();

  beforeEach(() => {
    vi.useFakeTimers();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
    boardCacheStore.hydrate({ b1: makeBoard('b1', 'Plan') }, { b1: OLD });
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    saves = [];
    recreates = [];
    __resetBaselinesForTests();
    onReconcile = () => {};
    fileExists = false;
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'board:save') {
        saves.push(args[1] as string);
        if ((args[3] as { recreate?: boolean } | undefined)?.recreate) recreates.push(args[1] as string);
        return { ok: true };
      }
      if (channel === 'vault:reconcile') {
        onReconcile();
        return { success: true };
      }
      if (channel === 'vault:file-exists') return fileExists;
      if (channel === 'vault:stat') return { success: false, code: 'ENOENT' };
      return { success: true, ok: true };
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetDirtyTrackingForTests();
    boardCacheStore.hydrate({}, {});
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    restoreFiloDefault();
  });

  it('a pending edit survives a folder rename and lands at the NEW path (bite)', async () => {
    boardCacheStore.markDirty('b1'); // an unsaved edit (debounced write armed)
    // The reconcile walk pairs the rename and rebinds the board.
    onReconcile = () => { boardCacheStore.renameBoardPath(OLD, NEW); };
    markBoardProvisionallyMissing('b1', OLD, captureVaultIdentity(), enqueue);
    expect(isBoardPathHeld(OLD)).toBe(true);

    await vi.advanceTimersByTimeAsync(RECHECK_GRACE_MS + 500);

    expect(boardCacheStore.paths.b1).toBe(NEW);
    expect(boardCacheStore.cache.b1).toBeDefined(); // NOT evicted
    expect(saves).not.toContain(OLD); // the old folder was never recreated
    expect(saves).toContain(NEW); // the held edit landed at the new path
    expect(isBoardPathHeld(OLD)).toBe(false);
  });

  it('really deleted with no unsaved write → evicted after the re-check', async () => {
    markBoardProvisionallyMissing('b1', OLD, captureVaultIdentity(), enqueue);
    expect(boardCacheStore.cache.b1).toBeDefined(); // not evicted immediately
    await vi.advanceTimersByTimeAsync(RECHECK_GRACE_MS + 100);
    expect(boardCacheStore.cache.b1).toBeUndefined();
  });

  it('deleted WITH an unsaved write → sticky prompt; "Discard changes" evicts', async () => {
    boardCacheStore.markDirty('b1');
    markBoardProvisionallyMissing('b1', OLD, captureVaultIdentity(), enqueue);
    await vi.advanceTimersByTimeAsync(RECHECK_GRACE_MS + 500);
    const toast = uiStore.toasts.find((t) => t.dedupeKey === 'board-missing:b1');
    expect(toast?.sticky).toBe(true);
    expect(boardCacheStore.cache.b1).toBeDefined();
    expect(saves).toEqual([]);
    await toast!.actions!.find((a) => a.label === 'Discard changes')!.handler();
    expect(boardCacheStore.cache.b1).toBeUndefined();
    expect(saves).toEqual([]);
  });

  it('"Save at original location" recreates the file with the edit', async () => {
    boardCacheStore.markDirty('b1');
    markBoardProvisionallyMissing('b1', OLD, captureVaultIdentity(), enqueue);
    await vi.advanceTimersByTimeAsync(RECHECK_GRACE_MS + 500);
    const toast = uiStore.toasts.find((t) => t.dedupeKey === 'board-missing:b1');
    await toast!.actions!.find((a) => a.label === 'Save at original location')!.handler();
    expect(saves).toContain(OLD);
  });

  it('"Save at original location" recreates a loaded board (one with a drift baseline) and its folder', async () => {
    noteBaseline(OLD, 1000, 10, { ifUnchangedSince: baselineSeq(OLD) });
    boardCacheStore.markDirty('b1');
    markBoardProvisionallyMissing('b1', OLD, captureVaultIdentity(), enqueue);
    await vi.advanceTimersByTimeAsync(RECHECK_GRACE_MS + 500);
    const toast = uiStore.toasts.find((t) => t.dedupeKey === 'board-missing:b1');
    const saved = toast!.actions!.find((a) => a.label === 'Save at original location')!.handler();
    await vi.advanceTimersByTimeAsync(1000); // the writer's re-stat of a missing file
    await saved;
    expect(recreates).toEqual([OLD]);
  });

  it('a later write of a missing board recreates nothing unless asked', async () => {
    noteBaseline(OLD, 1000, 10, { ifUnchangedSince: baselineSeq(OLD) });
    boardCacheStore.markDirty('b1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toEqual([]);
    expect(recreates).toEqual([]);
  });

  it('the file is back on disk → released, board kept', async () => {
    fileExists = true;
    markBoardProvisionallyMissing('b1', OLD, captureVaultIdentity(), enqueue);
    await vi.advanceTimersByTimeAsync(RECHECK_GRACE_MS + 100);
    expect(boardCacheStore.cache.b1).toBeDefined();
    expect(isBoardPathHeld(OLD)).toBe(false);
  });

  it('a vault swap during the wait → the re-check bails (no eviction in the new vault)', async () => {
    markBoardProvisionallyMissing('b1', OLD, captureVaultIdentity(), enqueue);
    beginVaultGeneration('/other'); // swap
    await vi.advanceTimersByTimeAsync(RECHECK_GRACE_MS + 100);
    expect(boardCacheStore.cache.b1).toBeDefined();
  });
});
