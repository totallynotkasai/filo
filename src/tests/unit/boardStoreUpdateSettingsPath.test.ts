import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Single settings write path.
 *
 * Asserts that `boardStore.updateSettings` / `deleteSettingsKeys` write
 * through the cache via `boardCacheStore.updateBoardSettings` and mirror onto
 * the active proxy — regardless of whether `boardStore.current` and
 * `boardCache[id].board` are the same Svelte 5 $state proxy or two distinct
 * proxies wrapping the same Board. The earlier path relied on the
 * dual-proxy invariant for persistence (touchBoard only), which is a
 * known footgun (see [pendingSettingsApplyBoard.test.ts] for the original
 * regression).
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMapFixture(): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {
        backgroundColor: '',
        backgroundPattern: 'grid',
        semanticZoom: true,
        snapToGrid: false,
      },
      viewport: { x: 0, y: 0, scale: 1 },
      placements: {},
      inlineTiles: {},
      waypoints: [],
      groups: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('boardStore.updateSettings — single write path', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    const fixture = makeMindMapFixture();
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
    boardStore.setBoard(fixture.board);
  });

  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('writes the merged patch into the cache snapshot synchronously', () => {
    boardStore.updateSettings({ backgroundColor: '#ff0000' });
    const cached = boardCacheStore.cache.mm;
    const cachedSettings = (cached.board as { settings: Record<string, unknown> }).settings;
    expect(cachedSettings.backgroundColor).toBe('#ff0000');
  });

  it('mirrors the patch onto boardStore.current for immediate reactivity', () => {
    boardStore.updateSettings({ backgroundColor: '#00ff00' });
    const current = boardStore.current;
    expect(current).not.toBeNull();
    const settings = (current as { settings: Record<string, unknown> }).settings;
    expect(settings.backgroundColor).toBe('#00ff00');
  });

  it('persists when the cache board and active board are distinct $state proxies', () => {
    // Forge the dual-proxy scenario: rewrite `cached.board` to a fresh copy
    // so `Object.is(cached.board, boardStore.current)` becomes false. This
    // emulates the lazy-wrapping behaviour Svelte 5 exhibits in practice
    // (the original bug from [pendingSettingsApplyBoard.test.ts]).
    const cached = boardCacheStore.cache.mm;
    const liveBoard = cached.board as MindMapBoard;
    const cloneBoard = { ...liveBoard, settings: { ...liveBoard.settings } } as MindMapBoard;
    boardCacheStore.replaceCache({
      mm: { ...cached, board: cloneBoard },
    });

    boardStore.updateSettings({ backgroundColor: '#1234ab' });

    // Cache snapshot — the sink the disk writer reads from — MUST carry the change.
    const reCached = boardCacheStore.cache.mm;
    const cachedSettings = (reCached.board as { settings: Record<string, unknown> }).settings;
    expect(cachedSettings.backgroundColor).toBe('#1234ab');
  });

  it('deleteSettingsKeys removes the keys from the cache and active proxy', () => {
    boardStore.updateSettings({ backgroundColor: '#aaaaaa', snapToGrid: true });
    boardStore.deleteSettingsKeys(['backgroundColor']);

    const cached = boardCacheStore.cache.mm;
    const cachedSettings = (cached.board as { settings: Record<string, unknown> }).settings;
    expect('backgroundColor' in cachedSettings).toBe(false);
    expect(cachedSettings.snapToGrid).toBe(true);

    const current = boardStore.current;
    const activeSettings = (current as { settings: Record<string, unknown> }).settings;
    expect('backgroundColor' in activeSettings).toBe(false);
    expect(activeSettings.snapToGrid).toBe(true);
  });

  it('bumps settingsVersion on every mutation so chained-getter consumers re-evaluate', () => {
    const before = boardStore.settingsVersion;
    boardStore.updateSettings({ backgroundColor: '#cccccc' });
    expect(boardStore.settingsVersion).toBe(before + 1);
    boardStore.deleteSettingsKeys(['backgroundColor']);
    expect(boardStore.settingsVersion).toBe(before + 2);
  });

  it('schedules a debounced disk write for the active board', async () => {
    vi.useFakeTimers();
    let writeCalled = false;
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string) => {
        if (channel === 'board:save') {
          writeCalled = true;
          return { ok: true, data: { path: 'map.board.json' } };
        }
        return null;
      },
      on: () => () => {},
      send: () => {},
    };

    boardStore.updateSettings({ backgroundColor: '#9999ff' });

    vi.advanceTimersByTime(400);
    // Let the microtask resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(writeCalled).toBe(true);
    vi.useRealTimers();
  });

  it('is a no-op when no board is active', () => {
    boardStore.clearBoard();
    expect(() => boardStore.updateSettings({ backgroundColor: '#abcdef' })).not.toThrow();
    expect(() => boardStore.deleteSettingsKeys(['backgroundColor'])).not.toThrow();
    expect(boardStore.current).toBeNull();
  });
});
