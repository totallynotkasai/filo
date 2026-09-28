/**
 * An Audio tile's take is saved and linked to the board it was recorded on,
 * even when the tile unmounts before the save finishes (a tab switch, a board
 * closed) and another board is active by then. Leaving the vault or quitting
 * stops a running take and waits for it; Ctrl+S leaves it running.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import AudioTileView from '@renderer/components/tiles/AudioTile.svelte';
import { BOARD_SCOPE_KEY, type BoardScope } from '@renderer/lib/boards/boardScope.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { recordingTiles } from '@renderer/stores/tiles.svelte';
import { flushAllComponents, __resetComponentFlushesForTests } from '@renderer/lib/boards/componentFlush';
import { holdCloseDrainUntilSwap } from '@renderer/lib/editor/closeDrainGate.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { AudioTile, MindMapBoard } from '@renderer/schema/index';

const invokes: unknown[][] = [];
let instance: ReturnType<typeof mount> | null = null;
let recorders: FakeRecorder[] = [];

class FakeRecorder {
  static isTypeSupported = (): boolean => false;
  mimeType = 'audio/webm';
  state = 'inactive';
  stream = { getTracks: (): unknown[] => [] };
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() {
    recorders.push(this);
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['abc'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

function mindmap(id: string): BoardFileData {
  const now = 0;
  return {
    version: 8,
    board: {
      id, name: id, emoji: '', type: 'mindmap', settings: {}, createdAt: now, updatedAt: now,
      placements: { a1: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false } },
      inlineTiles: {},
    } as unknown as MindMapBoard,
    tileDefs: id === 'b1'
      ? { a1: { id: 'a1', type: 'audio', title: 'Take', src: '', isPlaying: false, style: {}, createdAt: now, updatedAt: now } as unknown as BoardFileData['tileDefs'][string] }
      : {},
    connections: {},
    frames: [],
  } as BoardFileData;
}

// The pane's board scope: which board is active in it can change under the tile.
let current: MindMapBoard;
function scope(): BoardScope {
  return { board: { get current() { return current; }, updateTile: vi.fn() } } as unknown as BoardScope;
}

function mountTile(): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const tile = { id: 'a1', type: 'audio', src: '' } as unknown as AudioTile;
  instance = mount(AudioTileView, {
    target,
    props: { tile },
    context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, scope()]]),
  });
  flushSync();
  return target;
}

async function startTake(root: HTMLElement): Promise<FakeRecorder> {
  const btn = [...root.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Record Audio');
  if (!btn) throw new Error('no Record Audio button');
  btn.click();
  await vi.waitFor(() => expect(recorders).toHaveLength(1));
  await vi.waitFor(() => expect(recordingTiles.has('a1')).toBe(true));
  return recorders[0]!;
}

function linkedSrc(boardId: string): string | undefined {
  return (boardCacheStore.cache[boardId]?.tileDefs.a1 as { src?: string } | undefined)?.src;
}

beforeEach(() => {
  invokes.length = 0;
  recorders = [];
  __resetDirtyTrackingForTests();
  __resetComponentFlushesForTests();
  vaultStore.setPath('C:/vault');
  boardCacheStore.hydrate({ b1: mindmap('b1'), b2: mindmap('b2') }, { b1: 'One.board.json', b2: 'Two.board.json' });
  current = boardCacheStore.cache.b1!.board as MindMapBoard;
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  installFiloMock((channel: string, ...args: unknown[]) => {
    invokes.push([channel, ...args]);
    if (channel === 'media:save-audio') return { success: true, path: 'rec.webm' };
    return { success: true, ok: true };
  });
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  document.body.innerHTML = '';
  recordingTiles.clear();
  boardCacheStore.clear();
  vaultStore.setPath('');
  restoreFiloDefault();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('an Audio tile recording', () => {
  it('unmounted by a board switch: the take is saved and linked to the board it was recorded on', async () => {
    const root = mountTile();
    await startTake(root);

    // The user switches to another board: the tile unmounts, which ends the take.
    current = boardCacheStore.cache.b2!.board as MindMapBoard;
    unmount(instance!);
    instance = null;

    await vi.waitFor(() => expect(linkedSrc('b1')).toBe('rec.webm'));
    expect(recordingTiles.has('a1')).toBe(false);
    expect(boardCacheStore.cache.b2!.tileDefs.a1).toBeUndefined();
  });

  it('a board file never records that a tile is recording', async () => {
    const root = mountTile();
    await startTake(root);
    expect(JSON.stringify(boardCacheStore.cache.b1)).not.toContain('isRecording');
    expect(root.textContent).toContain('Recording...');
  });

  it('leaving the vault stops the take and waits until it is linked', async () => {
    const root = mountTile();
    const recorder = await startTake(root);
    const release = holdCloseDrainUntilSwap();
    try {
      await flushAllComponents();
    } finally {
      release();
    }
    expect(recorder.state).toBe('inactive');
    expect(linkedSrc('b1')).toBe('rec.webm');
  });

  it('Ctrl+S leaves a running take alone', async () => {
    const root = mountTile();
    const recorder = await startTake(root);
    await flushAllComponents();
    expect(recorder.state).toBe('recording');
    expect(invokes.some(([c]) => c === 'media:save-audio')).toBe(false);
  });
});
