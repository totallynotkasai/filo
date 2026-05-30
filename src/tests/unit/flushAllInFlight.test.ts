/**
 * Phase 4 / 4.1 — `flushAll*` must await writes whose timer fired but
 * whose IPC promise is still pending.
 *
 * The bug: prior to this phase, each scheduler's `flushAll*` only
 * drained its `pending`/`pendingBoardWrites`/`pendingMiscWrites` map.
 * A user pressing Ctrl+S in the gap between (timer-fire → set inflight,
 * IPC awaiting) and (IPC resolves → endWrite) returned `{ failed: [] }`
 * immediately — even if the actual IPC ultimately rejected.
 *
 * The fix: each scheduler tracks an `inFlight` map populated at timer
 * fire time and consulted by `flushAll*`. `flushAll*` snapshots the
 * in-flight set up-front, awaits each tracked promise, and reads
 * `inFlightFailures` to attribute rejected paths into its `failed[]`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import {
  scheduleBoardWrite,
  cancelAllPendingWrites,
  scheduleMiscWrite,
  flushAllMisc,
  __resetDirtyTrackingForTests,
  type V7BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import { flushAllScheduledBoards } from '@renderer/lib/boards/boardWriteScheduler';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { MindMapBoard } from '@renderer/schema/index';

function emptyMindmapBoard(id: string): V7BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: id,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('flushAllPendingFrontmatterWrites — awaits in-flight writes', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    restoreFiloDefault();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    restoreFiloDefault();
    vi.useRealTimers();
  });

  it('returns failed[] when an in-flight write rejects mid-flush', async () => {
    vi.useFakeTimers();

    // Slow + failing IPC: the timer fires, the write starts, but the
    // IPC doesn't resolve (rejects) until after the flush is invoked.
    let rejectIpc!: (err: unknown) => void;
    const ipcPromise = new Promise<unknown>((_, rej) => {
      rejectIpc = rej;
    });
    installFiloMock({
      'vault:file-exists': () => true,
      'vault:write-existing-file-text': () => ipcPromise,
    });

    documentStore.loadDocument({
      docId: 'doc-1',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'hello',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-1', { id: 'doc-1', title: 'Notes' });

    scheduleFrontmatterWrite('Notes.md', 'doc-1');

    // Fire the timer — the write enters in-flight but does NOT resolve.
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    // Start flush — it should block waiting for the in-flight write.
    const flushPromise = flushAllPendingFrontmatterWrites();

    // Reject the IPC. flush must catch this and aggregate into failed[].
    rejectIpc(new Error('disk full'));

    const result = await flushPromise;
    expect(result.failed).toEqual(['Notes.md']);
  });

  it('returns failed[] empty when in-flight writes resolve successfully', async () => {
    vi.useFakeTimers();

    let resolveIpc!: (val: unknown) => void;
    const ipcPromise = new Promise((res) => {
      resolveIpc = res;
    });
    installFiloMock({
      'vault:file-exists': () => true,
      'vault:write-existing-file-text': () => ipcPromise,
    });

    documentStore.loadDocument({
      docId: 'doc-1',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'hello',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-1', { id: 'doc-1', title: 'Notes' });

    scheduleFrontmatterWrite('Notes.md', 'doc-1');
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    const flushPromise = flushAllPendingFrontmatterWrites();
    resolveIpc({ success: true });

    const result = await flushPromise;
    expect(result.failed).toEqual([]);
  });
});

describe('flushAllScheduledBoards — awaits in-flight writes', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    vi.useRealTimers();
  });

  it('returns failed[] when an in-flight board:save rejects mid-flush', async () => {
    vi.useFakeTimers();

    let rejectSave!: (err: unknown) => void;
    const savePromise = new Promise<unknown>((_, rej) => {
      rejectSave = rej;
    });
    installFiloMock({
      'board:save': () => savePromise,
    });

    const cached = emptyMindmapBoard('A');
    scheduleBoardWrite('A', () => ({
      vaultRoot: '/vault',
      boardPath: 'A.board.json',
      cached,
    }));

    // Fire the timer → in-flight write enters the inFlightBoardWrites
    // map. The IPC does not resolve yet.
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    const flushPromise = flushAllScheduledBoards(() => null);

    // Reject the IPC; flush should attribute this into failed[].
    rejectSave(new Error('EACCES'));

    const result = await flushPromise;
    expect(result.failed).toEqual(['A.board.json']);
  });
});

describe('flushAllMisc — awaits in-flight writes', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    vi.useRealTimers();
  });

  it('returns failed[] when an in-flight misc write rejects mid-flush', async () => {
    vi.useFakeTimers();

    let rejectWrite!: (err: unknown) => void;
    const writePromise = new Promise<void>((_, rej) => {
      rejectWrite = rej;
    });

    scheduleMiscWrite('tags', () => ({
      vaultRoot: '/vault',
      path: '.filo/tags.json',
      write: () => writePromise,
    }));

    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    const flushPromise = flushAllMisc();
    rejectWrite(new Error('disk full'));

    const result = await flushPromise;
    expect(result.failed).toEqual(['.filo/tags.json']);
  });
});
