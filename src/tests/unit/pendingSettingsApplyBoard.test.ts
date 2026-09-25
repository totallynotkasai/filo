import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pendingSettingsStore } from '@renderer/stores/pendingSettings.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Project } from '@renderer/schema/index';
import { ProjectSettingsSchema } from '@renderer/schema/settings';

/**
 * Regression: `pendingSettingsStore.applyBoard()` previously wrote only to
 * `boardStore.current.settings` and relied on the "single proxy invariant" —
 * the assumption that `boardCache[id].board` and `boardStore.current` were
 * two Svelte 5 $state proxies over the same underlying Board reference.
 *
 * In practice the invariant DOES NOT HOLD: Svelte 5 lazily creates distinct
 * proxies that don't share an underlying value, so the active-only write
 * never reached the cache. `writeBoardFile` then snapshotted the pre-Apply
 * settings and the customization was silently dropped on disk.
 *
 * The fix: route through `boardCacheStore.updateBoardSettings` (which mutates
 * the cache directly) and mirror onto active for UI reactivity.
 */

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler> = {}): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
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
        connectionsVisible: true,
        labelsVisible: true,
      },
      viewport: { x: 0, y: 0, scale: 1 },
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function seedProject(): void {
  const fixture = makeMindMapFixture();
  const project: Project = {
    version: 7,
    vaultPath: '/vault',
    name: 'Test',
    theme: 'light',
    settings: ProjectSettingsSchema.parse({}),
    boards: [fixture.board],
    connections: {},
    frames: [],
    tags: [],
    workspace: { openTabs: [], activeTabId: '' },
    createdAt: 0,
    updatedAt: 0,
  };
  // Use the vault store's internal setter via the public API.
  vaultStore.setPath('/vault');
  // The vault store doesn't expose a direct project setter; seed via the
  // internal getProject path by triggering the hydration that openVault does.
  // For this isolated test, we mutate the cache + boardStore.setBoard which
  // is the relevant code path. The vaultStore.project is only needed by
  // markMetaDirty which is not exercised here.
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  boardStore.setBoard(fixture.board, {}, {}, []);
  // Verify the test's premise: this is the proxy-mismatch scenario.
  // (We don't assert on it directly because the assertion's purpose is to
  // make the test's intent legible to future readers.)
  void project;
}

describe('pendingSettingsStore.applyBoard — proxy-mismatch persistence regression', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
    boardStore.clearBoard();
    pendingSettingsStore.cancel();
    vi.useFakeTimers();
  });
  afterEach(() => {
    boardCacheStore.clear();
    boardStore.clearBoard();
    pendingSettingsStore.cancel();
    vi.useRealTimers();
  });

  it('persists Current Board defaults edits into the cache (not just the active proxy)', () => {
    seedProject();

    // User opens the Settings modal — startBoard snapshots the live settings
    // into the pending copy.
    pendingSettingsStore.startBoard();
    expect(pendingSettingsStore.pendingBoardId).toBe('mm');

    // User picks a custom header colour via CurrentBoardSettings.svelte,
    // which routes through pendingSettingsStore.updateBoard.
    pendingSettingsStore.updateBoard('defaults.tile.headerColor', '#d32f2f');

    // User clicks Apply. Whether or not the active-proxy write propagates
    // (it doesn't, in practice), the cache MUST have the customization or
    // the next disk write will drop it.
    pendingSettingsStore.applyBoard();

    const cached = boardCacheStore.cache.mm;
    expect(cached).toBeDefined();
    const settings = (cached.board as { settings: Record<string, unknown> }).settings;
    expect(settings).toBeDefined();
    expect((settings.defaults as { tile?: { headerColor?: string } })?.tile?.headerColor).toBe('#d32f2f');
  });

  it('mirrors the write onto active boardStore.current so UI updates reactively', () => {
    seedProject();
    pendingSettingsStore.startBoard();
    pendingSettingsStore.updateBoard('defaults.tile.headerColor', '#00ff00');
    pendingSettingsStore.applyBoard();

    const current = boardStore.current;
    expect(current).not.toBeNull();
    const settings = (current as { settings: Record<string, unknown> }).settings;
    expect((settings.defaults as { tile?: { headerColor?: string } })?.tile?.headerColor).toBe('#00ff00');
  });

  it('schedules a board write so the change reaches disk on next flush', () => {
    seedProject();

    let writeCalled = false;
    installFiloStub({
      'board:save': () => {
        writeCalled = true;
        return { ok: true };
      },
    });

    pendingSettingsStore.startBoard();
    pendingSettingsStore.updateBoard('defaults.tile.headerColor', '#aaaaaa');
    pendingSettingsStore.applyBoard();

    // The write is debounced 300ms — advance past it.
    vi.advanceTimersByTime(400);
    // Let the microtask resolve.
    return Promise.resolve().then(() => {
      expect(writeCalled).toBe(true);
    });
  });

  it('also persists when there is no active board (settings modal for inactive board)', () => {
    seedProject();
    // Simulate the user closing the active tab so boardStore.current is null
    // while pendingBoardId still targets the inactive board.
    pendingSettingsStore.startBoard();
    pendingSettingsStore.updateBoard('defaults.tile.headerColor', '#cccccc');
    boardStore.clearBoard();
    pendingSettingsStore.applyBoard();

    const cached = boardCacheStore.cache.mm;
    expect(cached).toBeDefined();
    const settings = (cached.board as { settings: Record<string, unknown> }).settings;
    expect((settings.defaults as { tile?: { headerColor?: string } })?.tile?.headerColor).toBe('#cccccc');
  });
});
