/**
 * `flushAll*` must await writes whose timer fired but whose IPC promise is
 * still pending. A Ctrl+S in the gap between (timer fires, write IPC awaiting)
 * and (IPC settles) must not report `{ failed: [] }` for a write that then
 * rejects: each flush awaits what is in flight and attributes its failure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleBoardWrite,
  cancelAllPendingWrites,
  scheduleMiscWrite,
  flushAllMisc,
  __resetDirtyTrackingForTests,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import { flushAllScheduledBoards } from '@renderer/lib/boards/boardWriteScheduler';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import type { MindMapBoard } from '@renderer/schema/index';

function emptyMindmapBoard(id: string): BoardFileData {
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

describe('noteStore.flushAll — awaits in-flight writes', () => {
  let vault: MemoryVault;
  let release!: () => void;
  let entered!: Promise<void>;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    vault = installMemoryVault({ 'Notes.md': '---\ntitle: Notes\n---\nhello\n' });
    noteStore.__resetForTests();
    const gate = new Promise<void>((resolve) => { release = resolve; });
    entered = new Promise<void>((resolve) => {
      vault.beforeWrite = async (rel) => {
        if (!rel.endsWith('.md')) return;
        resolve();
        await gate;
      };
    });
  });
  afterEach(() => {
    release();
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('returns failed[] when an in-flight write rejects mid-flush', async () => {
    noteStore.patchFrontmatter('Notes.md', { set: { status: 'done' }, unset: [] });
    // The debounce fires and the write IPC starts, but does not settle yet.
    await entered;

    const flushPromise = noteStore.flushAll();
    vault.failNextWrite('Notes.md', 'EIO');
    release();

    const result = await flushPromise;
    expect(result.failed).toEqual(['Notes.md']);
    expect(vault.read('Notes.md')).toBe('---\ntitle: Notes\n---\nhello\n');
  });

  it('returns failed[] empty when in-flight writes resolve successfully', async () => {
    noteStore.patchFrontmatter('Notes.md', { set: { status: 'done' }, unset: [] });
    await entered;

    const flushPromise = noteStore.flushAll();
    release();

    const result = await flushPromise;
    expect(result.failed).toEqual([]);
    expect(vault.read('Notes.md')).toBe('---\ntitle: Notes\nstatus: done\n---\nhello\n');
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
