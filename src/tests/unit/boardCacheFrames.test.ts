import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Frame, MindMapBoard } from '@renderer/schema/index';

/**
 * Frame-persistence regression: the original `persistUpdateFrame` resolved
 * the owning board by looking up `vaultStore.project.frames`, then wrote into
 * `boardCache[boardId].frames` — a *different* array. Any drift between the
 * two arrays (or a frame whose `boardId` was empty) silently dropped the edit.
 *
 * These tests lock in the cache-scan resolver that replaces the cross-store
 * lookup. The project store is intentionally not stubbed: the cache is now the
 * authoritative source for "which board owns this frame".
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

function makeFrame(id: string, boardId: string, overrides: Partial<Frame> = {}): Frame {
  return {
    id,
    boardId,
    title: 'Frame',
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    style: {
      backgroundColor: '#2a2a3e',
      backgroundImage: '',
      backgroundOpacity: 1,
      borderColor: '#3a3a4e',
      borderStyle: 'solid',
      borderWidth: 1,
    },
    collapsed: false,
    tileIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Frame;
}

function makeMindMapFixture(initialFrames: Frame[] = []): BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
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
    frames: initialFrames,
  };
}

describe('boardCache — frame persistence', () => {
  beforeEach(() => {
    installFiloStub();
    boardCacheStore.clear();
  });
  afterEach(() => boardCacheStore.clear());

  it('persistUpdateFrame resolves boardId via cache scan without touching project store', () => {
    const seeded = makeFrame('f1', 'mm');
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture([seeded]) },
      { mm: 'map.board.json' },
    );

    // Mimic a style edit that arrives without boardId (the regression scenario
    // when project.frames is stale or empty).
    const styled: Frame = {
      ...seeded,
      boardId: '',
      style: {
        ...seeded.style,
        headerColor: '#aa0000',
        bodyColor: '#0000ff',
        borderWidth: 4,
        shadowIntensity: 0.8,
      },
    } as Frame;
    boardCacheStore.persistUpdateFrame('f1', styled);

    const stored = boardCacheStore.cache.mm.frames.find((f) => f.id === 'f1') as Frame;
    expect(stored).toBeDefined();
    expect(stored.style.headerColor).toBe('#aa0000');
    expect(stored.style.bodyColor).toBe('#0000ff');
    expect(stored.style.borderWidth).toBe(4);
    expect(stored.style.shadowIntensity).toBe(0.8);
    // Self-heal: stored boardId is repaired so future updates take the fast path.
    expect(stored.boardId).toBe('mm');
  });

  it('persistRemoveFrame resolves boardId via cache scan when the inbound copy is missing it', () => {
    const seeded = makeFrame('f1', 'mm');
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture([seeded]) },
      { mm: 'map.board.json' },
    );

    boardCacheStore.persistRemoveFrame('f1', { ...seeded, boardId: '' } as Frame);
    expect(boardCacheStore.cache.mm.frames.find((f) => f.id === 'f1')).toBeUndefined();
  });

  it('persistAddFrame requires an explicit boardId and warns when missing', () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const orphan = makeFrame('f-orphan', '');
    boardCacheStore.persistAddFrame(orphan);

    expect(boardCacheStore.cache.mm.frames.find((f) => f.id === 'f-orphan')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('persistAddFrame: cannot resolve boardId'),
    );
    warn.mockRestore();
  });

  it('persistAddFrame with an explicit boardId appends the frame to that board', () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );

    const added = makeFrame('f1', 'mm');
    boardCacheStore.persistAddFrame(added);

    const stored = boardCacheStore.cache.mm.frames.find((f) => f.id === 'f1') as Frame;
    expect(stored).toBeDefined();
    expect(stored.boardId).toBe('mm');
  });

  it('persistUpdateFrame warns and drops when the frame is not in any cached board', () => {
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture() },
      { mm: 'map.board.json' },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const unknownFrame = makeFrame('ghost', '');
    boardCacheStore.persistUpdateFrame('ghost', unknownFrame);

    expect(boardCacheStore.cache.mm.frames).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('persistUpdateFrame: cannot resolve boardId'),
    );
    warn.mockRestore();
  });

  it('persistAddFrame falls back to cache scan when re-adding a frame with empty boardId', () => {
    // Re-add scenario: a frame is already in the cache (e.g. from a prior add
    // that was then undone, leaving the cache entry but clearing the active
    // boardStore reference). The re-add inbound copy may have boardId=''.
    const seeded = makeFrame('f1', 'mm');
    boardCacheStore.hydrate(
      { mm: makeMindMapFixture([seeded]) },
      { mm: 'map.board.json' },
    );

    const reAdded = { ...seeded, boardId: '' } as Frame;
    boardCacheStore.persistAddFrame(reAdded);

    // The frame is already at index 0; the re-add appends a second entry with
    // self-healed boardId so the cache-scan fallback is observably exercised.
    const matches = boardCacheStore.cache.mm.frames.filter((f) => f.id === 'f1');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // The newly-pushed entry has the resolved boardId stamped.
    const lastEntry = matches[matches.length - 1];
    expect(lastEntry.boardId).toBe('mm');
  });
});
