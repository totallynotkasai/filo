import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Phase 6 / 6.3 — `updateBoardSettingsWithHistory` builds the inverse
 * patch by reading the live `previousSettings` object. For object-typed
 * values, the previous shallow assignment kept the inverse referencing
 * the same Svelte 5 $state proxy as the live store: any subsequent
 * mutation of that nested object — including the forward patch's own
 * merge — corrupted what undo would later restore.
 *
 * The fix is a JSON round-trip clone of each object-typed inverse value.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function makeMindMapFixture(settings: Record<string, unknown> = {}): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'M',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings,
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function activate(initialSettings: Record<string, unknown> = {}): void {
  const fixture = makeMindMapFixture(initialSettings);
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
  boardStore.setBoard(fixture.board, {}, {}, []);
  // IMPL_PLAN_2026-05-26 / Item 1 — `setBoard` no longer mutates
  // `historyStore.activeBoardId`; PaneView's `isActive`-gated $effect
  // owns that signal in production. Unit tests without a PaneView
  // mount call it explicitly here to keep the undo/redo helpers
  // routing to this fixture's stack.
  historyStore.setActiveBoard(fixture.board.id);
}

function getSettings(): Record<string, unknown> {
  return (boardStore.settings ?? {}) as Record<string, unknown>;
}

describe('updateBoardSettingsWithHistory — inverse patch is deep-cloned', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
  });

  it('mutating the live nested settings object after execute does not corrupt the inverse', () => {
    activate({
      defaults: { tile: { headerColor: '#aaa', bodyColor: '#bbb' } },
    });

    // Snapshot the live nested object — this is the same shape callers
    // pass as `previousSettings`.
    const previous = { ...getSettings() };

    // Forward patch replaces the nested defaults wholesale.
    boardStore.updateBoardSettingsWithHistory(
      { defaults: { tile: { headerColor: '#new-header', bodyColor: '#new-body' } } },
      previous,
    );
    expect((getSettings().defaults as { tile: { headerColor: string } }).tile.headerColor).toBe('#new-header');

    // Now mutate the LIVE defaults object directly — this is exactly the
    // mutation that the forward patch's `updateSettings` would do via
    // its merge step, and it's also what a later UI tweak would do.
    const live = getSettings().defaults as { tile: { headerColor: string; bodyColor: string } };
    live.tile.headerColor = '#mutated';
    live.tile.bodyColor = '#mutated';

    // Undo. With a shallow inverse, the live mutation would have leaked
    // into the inverse (because both pointed at the same nested object),
    // so undo would restore the mutated values instead of the original.
    historyStore.undo();
    const restored = getSettings().defaults as { tile: { headerColor: string; bodyColor: string } };
    expect(restored.tile.headerColor).toBe('#aaa');
    expect(restored.tile.bodyColor).toBe('#bbb');
  });

  it('primitives in the inverse round-trip unchanged', () => {
    activate({ connectionsVisible: true, gridSize: 20 });

    const previous = { ...getSettings() };
    boardStore.updateBoardSettingsWithHistory(
      { connectionsVisible: false, gridSize: 40 },
      previous,
    );
    expect(getSettings().connectionsVisible).toBe(false);
    expect(getSettings().gridSize).toBe(40);

    historyStore.undo();
    expect(getSettings().connectionsVisible).toBe(true);
    expect(getSettings().gridSize).toBe(20);
  });

  it('keys absent from previous land in deleteOnUndo (not inverse)', () => {
    activate({});
    boardStore.updateBoardSettingsWithHistory(
      { brandNew: { a: 1, b: 2 } },
      {},
    );
    expect((getSettings().brandNew as { a: number }).a).toBe(1);
    historyStore.undo();
    expect('brandNew' in getSettings()).toBe(false);
  });
});
