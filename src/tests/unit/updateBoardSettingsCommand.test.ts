import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { UpdateBoardSettingsCommand } from '@renderer/commands/index';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Phase 10.2 — UpdateBoardSettingsCommand. Each command captures a forward
 * patch and inverse patch; if a key didn't exist in the prior settings, it's
 * recorded in `deleteOnUndo` so undo removes it cleanly rather than leaving
 * a phantom `key: undefined`.
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
      name: 'Map',
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
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  boardStore.setBoard(fixture.board);
}

function getSettings(): Record<string, unknown> {
  return (boardStore.settings ?? {}) as Record<string, unknown>;
}

describe('UpdateBoardSettingsCommand', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('forward patch + inverse patch round-trip a single key', () => {
    activate({ connectionsVisible: true });
    const cmd = new UpdateBoardSettingsCommand(
      { connectionsVisible: false },
      { connectionsVisible: true },
      [],
    );
    cmd.execute();
    expect(getSettings().connectionsVisible).toBe(false);
    cmd.undo();
    expect(getSettings().connectionsVisible).toBe(true);
  });

  it('deleteOnUndo removes keys that did not exist beforehand', () => {
    activate({});
    const cmd = new UpdateBoardSettingsCommand(
      { newFlag: 'value' },
      {},
      ['newFlag'],
    );
    cmd.execute();
    expect(getSettings().newFlag).toBe('value');
    cmd.undo();
    expect('newFlag' in getSettings()).toBe(false);
  });

  it('mix of existing + new keys: inverse restores existing, delete clears new', () => {
    activate({ existingFlag: 'A' });
    const cmd = new UpdateBoardSettingsCommand(
      { existingFlag: 'B', brandNew: 1 },
      { existingFlag: 'A' },
      ['brandNew'],
    );
    cmd.execute();
    expect(getSettings().existingFlag).toBe('B');
    expect(getSettings().brandNew).toBe(1);
    cmd.undo();
    expect(getSettings().existingFlag).toBe('A');
    expect('brandNew' in getSettings()).toBe(false);
  });

  it('description includes patch keys by default', () => {
    const cmd = new UpdateBoardSettingsCommand({ a: 1, b: 2 }, {}, []);
    expect(cmd.description).toContain('a');
    expect(cmd.description).toContain('b');
  });

  it('honours a custom description', () => {
    const cmd = new UpdateBoardSettingsCommand({ a: 1 }, {}, [], 'Show connections');
    expect(cmd.description).toBe('Show connections');
  });
});
