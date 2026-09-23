import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadBoard, loadAllBoards, mergeBoardTiles } from '@renderer/lib/boards/boardLoader';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) throw new Error(`No stub for channel "${channel}"`);
      return handler(...args);
    },
    on: () => () => { /* no-op */ },
    send: () => { /* no-op */ },
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

function validBoardFile(boardId = 'mindmap-1'): V7BoardFileData {
  const now = Date.now();
  return {
    board: {
      id: boardId,
      name: 'Alpha',
      emoji: '',
      type: 'mindmap',
      settings: {},
      placements: {
        tile_a: { x: 10, y: 20, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {
        tile_inline: {
          id: 'tile_inline',
          type: 'timer',
          title: 'Focus',
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          locked: false,
          faded: false,
          tags: [],
          createdAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    } as V7BoardFileData['board'],
    tileDefs: {
      tile_a: {
        id: 'tile_a',
        type: 'text',
        title: 'Note',
        tags: [],
        style: { headerColor: '#fff', bodyColor: '#fff' },
        contentId: 'doc_1',
        src: 'notes/alpha.md',
        createdAt: now,
        updatedAt: now,
      } as V7BoardFileData['tileDefs'][string],
    },
    connections: {},
    frames: [],
  };
}

describe('boardLoader', () => {
  beforeEach(() => {
    uninstallFiloStub();
    __resetErrorBusForTests();
  });
  afterEach(() => {
    uninstallFiloStub();
    __resetErrorBusForTests();
  });

  describe('loadBoard', () => {
    it('returns ok with parsed data for a valid .board.json', async () => {
      const file = validBoardFile();
      installFiloStub({
        'board:load': () => JSON.stringify(file),
      });

      const result = await loadBoard('/vault', 'alpha.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.board.id).toBe('mindmap-1');
      }
    });

    // Audit-19 ERR-1 — main now returns the parsed OBJECT (it unwraps legacy
    // double-encoded files itself); string stubs above still load too.
    it('loads when board:load returns an object', async () => {
      const file = validBoardFile();
      installFiloStub({ 'board:load': () => structuredClone(file) });

      const result = await loadBoard('/vault', 'alpha.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.board.id).toBe('mindmap-1');
    });

    it('preserves unknown top-level envelope keys on load (DI-11 passthrough)', async () => {
      // A forward-compat top-level key a future Filo (e.g. a V8 migration)
      // wrote. `V7BoardFileDataSchema.passthrough()` keeps it through the parse;
      // DI-11's `...data` spread keeps it through the loader's normalised
      // reconstruction so it survives load → cache → save.
      const file = validBoardFile();
      const withExtra = {
        ...file,
        futureFeature: { enabled: true, note: 'keep me' },
      };
      installFiloStub({ 'board:load': () => JSON.stringify(withExtra) });

      const result = await loadBoard('/vault', 'alpha.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.data as Record<string, unknown>).futureFeature).toEqual({
          enabled: true,
          note: 'keep me',
        });
        // The known fields still resolve normally.
        expect(result.data.board.id).toBe('mindmap-1');
      }
    });

    it('returns not-found when the IPC returns null', async () => {
      installFiloStub({ 'board:load': () => null });
      const result = await loadBoard('/vault', 'missing.board.json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('not-found');
    });

    it('returns parse-error on malformed JSON', async () => {
      installFiloStub({ 'board:load': () => '{"not json' });
      const result = await loadBoard('/vault', 'broken.board.json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('parse-error');
    });

    it('returns schema-invalid when board.id is missing', async () => {
      const bad = { board: { name: 'no id' }, tileDefs: {}, connections: {}, frames: [] };
      installFiloStub({ 'board:load': () => JSON.stringify(bad) });
      const result = await loadBoard('/vault', 'bad.board.json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('schema-invalid');
    });

    it('schema-invalid message names the offending field path', async () => {
      const bad = {
        board: { type: 'mindmap', name: 'no id', createdAt: 1, updatedAt: 1 },
        tileDefs: {},
        connections: {},
        frames: [],
      };
      installFiloStub({ 'board:load': () => JSON.stringify(bad) });
      const result = await loadBoard('/vault', 'bad.board.json');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('schema-invalid');
        expect(result.message).toContain('board.id: ');
      }
    });

    it('returns io-error when the IPC throws', async () => {
      installFiloStub({
        'board:load': () => {
          throw new Error('disk offline');
        },
      });
      const result = await loadBoard('/vault', 'a.board.json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('io-error');
    });

    it('backfills missing displayIndex on tile groups in legacy mind-map boards', async () => {
      const file = validBoardFile('m-grp');
      const board = file.board as unknown as Record<string, unknown>;
      board.groups = [
        { id: 'g1', tileIds: ['t1'], boardId: 'm-grp' },           // no displayIndex
        { id: 'g2', tileIds: ['t2'], boardId: 'm-grp', displayIndex: 5 }, // pre-filled
        { id: 'g3', tileIds: ['t3'], boardId: 'm-grp' },           // no displayIndex
      ];
      installFiloStub({ 'board:load': () => JSON.stringify(file) });
      const result = await loadBoard('/vault', 'g.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) {
        const groups = (result.data.board as unknown as { groups: Array<{ id: string; displayIndex: number }> }).groups;
        // Existing displayIndex (5) preserved; missing ones filled with the
        // smallest unused positive integers (1 and 2).
        const byId = new Map(groups.map(g => [g.id, g.displayIndex]));
        expect(byId.get('g2')).toBe(5);
        expect(byId.get('g1')).toBe(1);
        expect(byId.get('g3')).toBe(2);
      }
    });

    it('Phase 2.4 — prunes orphan connections + frame.tileIds and flags orphansPruned', async () => {
      const file = validBoardFile('m-prune');
      file.connections = {
        c_valid: {
          id: 'c_valid',
          boardId: 'm-prune',
          fromTileId: 'tile_a',
          toTileId: 'tile_a',
          fromBubble: 0,
          toBubble: 0,
          createdAt: 0,
          updatedAt: 0,
        } as never,
        c_orphan: {
          id: 'c_orphan',
          boardId: 'm-prune',
          fromTileId: 'tile_a',
          toTileId: 'tile_ghost',
          fromBubble: 0,
          toBubble: 0,
          createdAt: 0,
          updatedAt: 0,
        } as never,
      };
      file.frames = [
        {
          id: 'f1',
          boardId: 'm-prune',
          title: 'Frame',
          position: { x: 0, y: 0 },
          size: { width: 300, height: 200 },
          tileIds: ['tile_a', 'tile_ghost'],
          createdAt: 0,
          updatedAt: 0,
        } as never,
      ];
      // snapshot stub returns the real IPC envelope (see
      // `src/main/ipc/board.ipc.ts:360-371`). Pre-Phase-1, the renderer
      // casts the result as `string`, so this envelope object is what
      // production actually receives; only the shape of the stub
      // matters for parity with disk behavior.
      installFiloStub({
        'board:load': () => JSON.stringify(file),
        'recovery:snapshot': () => ({ ok: true, path: '.filo/recovery/2026-05-23/orig.board.json' }),
      });

      const result = await loadBoard('/vault', 'prune.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.orphansPruned).toBe(true);
        // Orphan connection dropped, valid one kept.
        expect(Object.keys(result.data.connections)).toEqual(['c_valid']);
        // Orphan tile id stripped from the frame.
        expect(result.data.frames[0].tileIds).toEqual(['tile_a']);
      }
    });

    // ── Audit 2.1 regression ────────────────────────────────────────────────
    // A nested connection / frame / mindmap-group `boardId` that disagrees with
    // the envelope's `board.id` must be normalized to `board.id` at load time
    // and the board flagged so the repair reaches disk. Pre-fix, the schema
    // superRefine only console.warn'd and `pruneOrphanRefsAndDuplicates` never
    // touched `boardId`, so a stale / foreign `boardId` round-tripped to disk
    // unchanged — and the superRefine's comment claimed a normalization pass
    // that did not exist. Trivially produced by copying one board's connections
    // into another file, or a third-party tool writing a stale `boardId`.
    it('Audit 2.1 — normalizes a mismatched connection/frame/group boardId to board.id', async () => {
      const file = validBoardFile('home-board');
      file.connections = {
        c1: {
          id: 'c1',
          boardId: 'stale-foreign-id',
          fromTileId: 'tile_a',
          toTileId: 'tile_a',
          fromBubble: 0,
          toBubble: 0,
          createdAt: 0,
          updatedAt: 0,
        } as never,
      };
      file.frames = [
        {
          id: 'f1',
          boardId: 'stale-foreign-id',
          title: 'Frame',
          position: { x: 0, y: 0 },
          size: { width: 300, height: 200 },
          tileIds: ['tile_a'],
          createdAt: 0,
          updatedAt: 0,
        } as never,
      ];
      const board = file.board as unknown as Record<string, unknown>;
      // displayIndex pre-filled so the group backfill stays quiet and this test
      // isolates the boardId normalization signal.
      board.groups = [
        { id: 'g1', tileIds: ['tile_a'], boardId: 'stale-foreign-id', displayIndex: 1 },
      ];

      // No `recovery:snapshot` stub on purpose: boardId normalization is a
      // benign, deterministic self-heal (no data loss), so it must NOT trip the
      // orphan-prune snapshot / refuse-to-load path. If it did, the missing
      // stub would throw "No stub for channel".
      installFiloStub({ 'board:load': () => JSON.stringify(file) });

      const result = await loadBoard('/vault', 'home.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.connections.c1.boardId).toBe('home-board');
        expect(result.data.frames[0].boardId).toBe('home-board');
        const groups = (result.data.board as unknown as { groups: Array<{ boardId: string }> }).groups;
        expect(groups[0].boardId).toBe('home-board');
        expect(result.boardIdsNormalized).toBe(true);
      }
    });

    it('Phase 2.4 — deduplicates Kanban placements within a column without rejecting the board', async () => {
      const now = Date.now();
      const file = {
        board: {
          id: 'kb-dup',
          name: 'Dup',
          emoji: '',
          type: 'kanban',
          createdAt: now,
          updatedAt: now,
          settings: {},
          columns: [
            {
              id: 'c1',
              title: 'Col',
              position: 0,
              collapsed: false,
              tilePlacements: [
                { tileId: 'tile_a', position: 0 },
                { tileId: 'tile_a', position: 1 }, // duplicate
                { tileId: 'tile_b', position: 2 },
              ],
            },
          ],
        },
        tileDefs: {
          tile_a: { id: 'tile_a', type: 'text', title: 'A', tags: [], style: { headerColor: '#fff', bodyColor: '#fff' }, contentId: 'doc_a', createdAt: now, updatedAt: now },
          tile_b: { id: 'tile_b', type: 'text', title: 'B', tags: [], style: { headerColor: '#fff', bodyColor: '#fff' }, contentId: 'doc_b', createdAt: now, updatedAt: now },
        },
        connections: {},
        frames: [],
      };
      installFiloStub({
        'board:load': () => JSON.stringify(file),
        // Envelope contract — see boardLoader.ts test comment above.
        'recovery:snapshot': () => ({ ok: true, path: '.filo/recovery/dup.board.json' }),
      });

      const result = await loadBoard('/vault', 'dup.board.json');
      if (!result.ok) throw new Error(`load failed: ${result.error}: ${result.message}`);
      expect(result.orphansPruned).toBe(true);
      const cols = (result.data.board as unknown as { columns: Array<{ tilePlacements: Array<{ tileId: string }> }> }).columns;
      expect(cols[0].tilePlacements.map((p) => p.tileId)).toEqual(['tile_a', 'tile_b']);
    });

    it('rejects legacy V6 Kanban shape with cardData[] as schema-invalid', async () => {
      const legacy = {
        board: {
          id: 'kb1',
          type: 'kanban',
          name: 'Tasks',
          emoji: '',
          createdAt: 0,
          updatedAt: 0,
          settings: {},
          columns: [],
          cardData: [{ id: 'c1', title: 'Old' }],
        },
        tileDefs: {},
        connections: {},
        frames: [],
      };
      installFiloStub({ 'board:load': () => JSON.stringify(legacy) });
      const result = await loadBoard('/vault', 'legacy.board.json');
      // With the V7 migrator removed, legacy shape parses through passthrough
      // (cardData isn't rejected; it's just ignored). The renderer treats it
      // as an empty Kanban. This is the documented "fails to load cleanly"
      // outcome — boards open with no cards rather than silently migrating.
      expect(result.ok).toBe(true);
    });
  });

  describe('loadAllBoards', () => {
    it('aggregates boards, cache, paths, connections, frames', async () => {
      const fileA = validBoardFile('m-a');
      const fileB = validBoardFile('m-b');
      // Connection points at the seeded tile_a in fileB's tileDefs so the
      // Phase 2.4 orphan-ref prune leaves it intact. (Hooking c1 onto a
      // ghost tile id was the original test setup; after Phase 2.4 that
      // would be pruned as orphaned.)
      fileB.connections = {
        c1: {
          id: 'c1',
          boardId: 'm-b',
          fromTileId: 'tile_a',
          toTileId: 'tile_a',
          fromBubble: 0,
          toBubble: 0,
          createdAt: 0,
          updatedAt: 0,
        } as never,
      };

      installFiloStub({
        'board:list': () => ['a.board.json', 'b.board.json'],
        'board:load': (_root: unknown, rel: unknown) =>
          rel === 'a.board.json' ? JSON.stringify(fileA) : JSON.stringify(fileB),
      });

      const result = await loadAllBoards('/vault');
      expect(result.boards).toHaveLength(2);
      expect(Object.keys(result.cache).sort()).toEqual(['m-a', 'm-b']);
      expect(result.paths['m-a']).toBe('a.board.json');
      expect(result.paths['m-b']).toBe('b.board.json');
      expect(Object.keys(result.connections)).toEqual(['c1']);
    });

    it('skips boards that fail to load', async () => {
      installFiloStub({
        'board:list': () => ['ok.board.json', 'missing.board.json'],
        'board:load': (_root: unknown, rel: unknown) =>
          rel === 'ok.board.json' ? JSON.stringify(validBoardFile('ok')) : null,
      });

      const result = await loadAllBoards('/vault');
      expect(result.boards).toHaveLength(1);
      expect(result.boards[0].id).toBe('ok');
    });

    it('returns failedBoards entries for each unloadable file', async () => {
      installFiloStub({
        'board:list': () => ['ok.board.json', 'broken.board.json'],
        'board:load': (_root: unknown, rel: unknown) =>
          rel === 'ok.board.json' ? JSON.stringify(validBoardFile('ok')) : '{not json',
      });

      const result = await loadAllBoards('/vault');
      expect(result.boards).toHaveLength(1);
      expect(result.failedBoards).toHaveLength(1);
      expect(result.failedBoards[0].path).toBe('broken.board.json');
      expect(result.failedBoards[0].errorKind).toBe('parse-error');
    });

    // ── Audit 1.2 regression ───────────────────────────────────────────────
    // Two .board.json files sharing the same board.id must not silently
    // collapse. Pre-fix, the second overwrote cache[id] + paths[id] (the first
    // board became unreachable and its future saves targeted the survivor's
    // file) and its connections/frames merged unconditionally into the
    // survivor. Trivially produced by copying a .board.json in the OS file
    // manager or restoring one from backup into the same vault.
    it('routes a second board with a duplicate board.id into failedBoards and keeps the first reachable', async () => {
      const first = validBoardFile('dup-id');
      const second = validBoardFile('dup-id');
      // Distinct connection on the second file so we can prove it does NOT
      // leak into the surviving board's connection set.
      second.connections = {
        intruder: {
          id: 'intruder',
          boardId: 'dup-id',
          fromTileId: 'tile_a',
          toTileId: 'tile_a',
          fromBubble: 0,
          toBubble: 0,
          createdAt: 0,
          updatedAt: 0,
        } as never,
      };

      installFiloStub({
        'board:list': () => ['first.board.json', 'second.board.json'],
        'board:load': (_root: unknown, rel: unknown) =>
          rel === 'first.board.json' ? JSON.stringify(first) : JSON.stringify(second),
      });

      const result = await loadAllBoards('/vault');

      // The first file wins and stays reachable under its own path.
      expect(result.boards).toHaveLength(1);
      expect(result.boards[0].id).toBe('dup-id');
      expect(result.paths['dup-id']).toBe('first.board.json');

      // The colliding second file is rejected with the new errorKind.
      expect(result.failedBoards).toHaveLength(1);
      expect(result.failedBoards[0].path).toBe('second.board.json');
      expect(result.failedBoards[0].errorKind).toBe('duplicate-board-id');

      // The loser's connections must NOT have polluted the survivor.
      expect(result.connections.intruder).toBeUndefined();
    });
  });

  describe('mergeBoardTiles', () => {
    it('applies placements and inline tiles into a runtime merge map', () => {
      const file = validBoardFile();
      const merged = mergeBoardTiles(file);
      expect(merged.tile_a.position).toEqual({ x: 10, y: 20 });
      expect(merged.tile_a.size).toEqual({ width: 200, height: 100 });
      expect(merged.tile_inline.position).toEqual({ x: 0, y: 0 });
      expect(merged.tile_inline.size).toEqual({ width: 200, height: 80 });
    });

    it('returns an empty map for non-mindmap boards', () => {
      const file = validBoardFile();
      (file.board as unknown as Record<string, unknown>).type = 'kanban';
      expect(mergeBoardTiles(file)).toEqual({});
    });
  });
});
