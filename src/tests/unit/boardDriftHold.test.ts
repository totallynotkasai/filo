/**
 * A board changed outside Filo while it has unsaved changes is held for the
 * user's Reload / Keep local answer, and nothing waits for that answer:
 * - the write that finds the drift fails at once (no prompt awaited), raises
 *   no "couldn't save" toast, and keeps the board's change retained;
 * - a later save, a quit drain or a Retry doesn't re-fire it (it would only
 *   meet the same question) and returns at once;
 * - Keep local re-fires the held write, Reload drops it;
 * - while held, the board is a held decision (listed by the save indicator,
 *   and quit says it is waiting for a decision).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scheduleBoardWrite,
  flushAllScheduledBoards,
  setBoardExternalEditHandler,
  retryFailedBoardWrite,
  discardBoardWrite,
  boardHasUnsavedWrite,
  writeBoardFile,
} from '@renderer/lib/boards/boardWriteScheduler';
import { retryAllFailedWrites } from '@renderer/lib/boards/writeSchedulerFailures';
import { isBoardDriftHeld, releaseBoardDrift, holdBoardDrift } from '@renderer/lib/boards/boardDriftHold';
import { noteBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import {
  __resetDirtyTrackingForTests,
  setWriteErrorListener,
  unsavedWork,
  type WriteErrorInfo,
} from '@renderer/lib/boards/writeStateTracking';
import { vaultPath } from '@shared/vaultPath';
import { resolveBoardDrift } from '@renderer/stores/boardDrift';
import { heldDecisions } from '@renderer/stores/heldDecisions';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import type { BoardFileData } from '@renderer/lib/boards/tileDefBuilder';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const PATH = 'Plan.board.json';

function cachedBoard(): BoardFileData {
  return {
    board: { id: 'b', type: 'mindmap', name: 'Plan', emoji: '', createdAt: 0, updatedAt: 0, settings: {}, placements: {}, inlineTiles: {}, waypoints: [] },
    tileDefs: {},
    connections: {},
    frames: [],
  } as unknown as BoardFileData;
}

const args = (): { vaultRoot: string; boardPath: string; cached: BoardFileData } => ({
  vaultRoot: '/v',
  boardPath: PATH,
  cached: cachedBoard(),
});

interface Disk {
  calls: string[];
  stat: { mtimeMs: number; size: number };
}

function installDisk(): Disk {
  const disk: Disk = { calls: [], stat: { mtimeMs: 2000, size: 50 } };
  installFiloMock((channel: string) => {
    disk.calls.push(channel);
    if (channel === 'vault:stat') return { success: true, ...disk.stat };
    return { success: true };
  });
  return disk;
}

const count = (disk: Disk, channel: string): number => disk.calls.filter((c) => c === channel).length;

function driftToasts(): typeof uiStore.toasts {
  return uiStore.toasts.filter((t) => t.text.includes('was changed outside Filo'));
}

describe('a board held for a drift answer', () => {
  let errors: WriteErrorInfo[];
  let asked: string[];

  beforeEach(() => {
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    errors = [];
    asked = [];
    setWriteErrorListener((info) => errors.push(info));
    // The file on disk (2000 / 50) is not the one Filo last wrote (1000 / 200).
    noteBaseline(PATH, 1000, 200);
    // An answer that never comes: nothing may wait for it.
    setBoardExternalEditHandler((path) => {
      asked.push(path);
      return new Promise(() => {});
    });
  });

  afterEach(() => {
    setBoardExternalEditHandler(null);
    setWriteErrorListener(null);
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    restoreFiloDefault();
  });

  it('the write that finds the drift fails at once, asks once, and raises no failure toast', async () => {
    const disk = installDisk();
    scheduleBoardWrite('b', args);
    const result = await flushAllScheduledBoards(() => null);

    expect(result.failed).toEqual([PATH]);
    expect(asked).toEqual([PATH]);
    expect(isBoardDriftHeld(PATH)).toBe(true);
    expect(count(disk, 'board:save')).toBe(0);
    expect(errors).toEqual([]);
    // Unsaved, so the sentinel and the rescue copies still cover it.
    expect(unsavedWork().failed).toContain(vaultPath(PATH));
    expect(boardHasUnsavedWrite('b')).toBe(true);
  });

  it('a later save, quit drain or Retry does not re-fire it or ask again', async () => {
    const disk = installDisk();
    scheduleBoardWrite('b', args);
    await flushAllScheduledBoards(() => null);
    const stats = count(disk, 'vault:stat');

    const again = await flushAllScheduledBoards(() => null);
    await retryAllFailedWrites();

    expect(again.failed).toEqual([]);
    expect(count(disk, 'vault:stat')).toBe(stats);
    expect(count(disk, 'board:save')).toBe(0);
    expect(asked).toEqual([PATH]);
    expect(errors).toEqual([]);
    expect(unsavedWork().failed).toContain(vaultPath(PATH));
  });

  it('a new edit while held is refused before any stat, and shows the question again', async () => {
    const disk = installDisk();
    holdBoardDrift(PATH);
    await expect(writeBoardFile('/v', PATH, cachedBoard())).rejects.toMatchObject({ code: 'BOARD_DRIFT_HELD' });
    expect(count(disk, 'vault:stat')).toBe(0);
    expect(asked).toEqual([PATH]);
    expect(errors).toEqual([]);
  });

  it('Keep local: once the hold is released, the held write goes to disk', async () => {
    const disk = installDisk();
    scheduleBoardWrite('b', args);
    await flushAllScheduledBoards(() => null);

    // What Keep local does: the baseline moves to the other version, the hold goes.
    noteBaseline(PATH, 2000, 50);
    releaseBoardDrift(PATH);
    await retryFailedBoardWrite('b');

    expect(count(disk, 'board:save')).toBe(1);
    expect(unsavedWork().failed).not.toContain(vaultPath(PATH));
    expect(boardHasUnsavedWrite('b')).toBe(false);
  });

  it('Reload: the held write is dropped, and nothing is left failed', async () => {
    const disk = installDisk();
    scheduleBoardWrite('b', args);
    await flushAllScheduledBoards(() => null);

    discardBoardWrite('b', PATH, '/v');
    releaseBoardDrift(PATH);
    await flushAllScheduledBoards(() => null);

    expect(count(disk, 'board:save')).toBe(0);
    expect(unsavedWork().failed).not.toContain(vaultPath(PATH));
    expect(boardHasUnsavedWrite('b')).toBe(false);
  });
});

describe('the drift question as a held decision', () => {
  beforeEach(() => {
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });

  afterEach(() => {
    releaseBoardDrift(PATH);
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('is listed while unanswered, survives a dismissed toast, re-opens, and goes when released', async () => {
    const answer = resolveBoardDrift(PATH);
    expect(isBoardDriftHeld(PATH)).toBe(true);
    expect(heldDecisions().map((d) => d.relPath())).toEqual([PATH]);

    // Dismissed: nothing was decided, so the decision stays listed.
    uiStore.dismissToast(driftToasts()[0].id);
    await expect(answer).resolves.toBe('defer');
    expect(heldDecisions().map((d) => d.relPath())).toEqual([PATH]);

    // The save popover's re-open shows the question again.
    heldDecisions()[0].reopen();
    expect(driftToasts()).toHaveLength(1);

    releaseBoardDrift(PATH);
    expect(heldDecisions()).toEqual([]);
  });
});

describe('the answer to a drift question follows a rename made while it was open', () => {
  const OLD = 'Old/Plan.board.json';
  const NEW = 'New/Plan.board.json';
  let calls: Array<[string, string]>;

  beforeEach(() => {
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    calls = [];
    installFiloMock((channel: string, _root: unknown, rel: unknown) => {
      calls.push([channel, String(rel)]);
      if (channel === 'vault:stat') return { success: true, mtimeMs: 2000, size: 50 };
      if (channel === 'recovery:snapshot') return { success: true, path: '/v/.filo/recovery/x/Plan.board.json' };
      return { success: true };
    });
    vaultStore.setPath('/v');
    beginVaultGeneration('/v');
    boardCacheStore.hydrate({ b: cachedBoard() }, { b: OLD });
  });

  afterEach(() => {
    releaseBoardDrift(NEW);
    releaseBoardDrift(OLD);
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    boardCacheStore.clear();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('Keep local backs up the file where it is now and releases its hold', async () => {
    const answer = resolveBoardDrift(OLD);
    // Another program moves the board while the question is open.
    boardCacheStore.renameBoardPath(OLD, NEW);
    renameAllPathKeys(OLD, NEW);
    expect(isBoardDriftHeld(NEW)).toBe(true);

    driftToasts()[0].actions?.find((a) => a.label === 'Keep local')?.handler();
    await expect(answer).resolves.toBe('keep-local');
    expect(isBoardDriftHeld(NEW)).toBe(false);
    expect(heldDecisions()).toEqual([]);
    expect(calls).toContainEqual(['recovery:snapshot', NEW]);
    expect(calls.some(([, rel]) => rel === OLD)).toBe(false);
    // A later drift of the renamed board asks again (nothing left stranded).
    const before = driftToasts().length;
    void resolveBoardDrift(NEW);
    expect(driftToasts()).toHaveLength(before + 1);
  });

  it('Reload reads the board at its new path', async () => {
    const answer = resolveBoardDrift(OLD);
    boardCacheStore.renameBoardPath(OLD, NEW);
    renameAllPathKeys(OLD, NEW);

    driftToasts()[0].actions?.find((a) => a.label === 'Reload')?.handler();
    await answer;
    expect(calls).toContainEqual(['board:load', NEW]);
    expect(calls.some(([channel, rel]) => channel === 'board:load' && rel === OLD)).toBe(false);
  });
});
