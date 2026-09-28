import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadBoard, loadAllBoards } from '@renderer/lib/boards/boardLoader';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
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

/** Main's `board:load` failure envelope for a file whose JSON doesn't parse. */
const PARSE_FAILURE = { success: false, code: 'PARSE', error: 'SyntaxError: Unexpected end of JSON input' };

function validBoardFile(boardId = 'mindmap-1'): BoardFileData {
  const now = Date.now();
  return {
    version: 8,
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
    } as BoardFileData['board'],
    tileDefs: {
      tile_a: {
        id: 'tile_a',
        type: 'text',
        filePath: 'notes/alpha.md',
        style: { headerColor: '#fff', bodyColor: '#fff' },
        createdAt: now,
        updatedAt: now,
      } as BoardFileData['tileDefs'][string],
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
      installFiloStub({ 'board:load': () => structuredClone(file) });

      const result = await loadBoard('/vault', 'alpha.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.board.id).toBe('mindmap-1');
        expect(result.data.tileDefs.tile_a).toMatchObject({ type: 'text', filePath: 'notes/alpha.md' });
      }
    });

    // Main hands the renderer the parsed board object. A JSON string payload
    // (a double-encoded file) is not a board envelope, so the version gate
    // refuses it rather than the renderer parsing it a second time.
    it('refuses a string payload as no-migration-path', async () => {
      const file = validBoardFile();
      installFiloStub({ 'board:load': () => JSON.stringify(file) });

      const result = await loadBoard('/vault', 'alpha.board.json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('no-migration-path');
    });

    it('preserves unknown top-level envelope keys on load (DI-11 passthrough)', async () => {
      // A forward-compat top-level key a future Filo wrote.
      // `BoardFileDataSchema.passthrough()` keeps it through the parse and
      // the loader's normalised reconstruction spreads it back in, so it
      // survives load → cache → save.
      const file = validBoardFile();
      const withExtra = {
        ...file,
        futureFeature: { enabled: true, note: 'keep me' },
      };
      installFiloStub({ 'board:load': () => structuredClone(withExtra) });

      const result = await loadBoard('/vault', 'alpha.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.data as BoardFileData & Record<string, unknown>).futureFeature).toEqual({
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
      installFiloStub({ 'board:load': () => PARSE_FAILURE });
      const result = await loadBoard('/vault', 'broken.board.json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('parse-error');
    });

    it('returns schema-invalid when board.id is missing', async () => {
      const bad = { version: 8, board: { name: 'no id' }, tileDefs: {}, connections: {}, frames: [] };
      installFiloStub({ 'board:load': () => structuredClone(bad) });
      const result = await loadBoard('/vault', 'bad.board.json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('schema-invalid');
    });

    it('schema-invalid message names the offending field path', async () => {
      const bad = {
        version: 8,
        board: { type: 'mindmap', name: 'no id', createdAt: 1, updatedAt: 1 },
        tileDefs: {},
        connections: {},
        frames: [],
      };
      installFiloStub({ 'board:load': () => structuredClone(bad) });
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

    it('loads tile groups exactly as stored (no displayIndex is invented)', async () => {
      const file = validBoardFile('m-grp');
      const board = file.board as unknown as Record<string, unknown>;
      board.groups = [
        { id: 'g1', tileIds: ['t1'], boardId: 'm-grp' },
        { id: 'g2', tileIds: ['t2'], boardId: 'm-grp', displayIndex: 5 },
      ];
      installFiloStub({ 'board:load': () => structuredClone(file) });
      const result = await loadBoard('/vault', 'g.board.json');
      expect(result.ok).toBe(true);
      if (result.ok) {
        const groups = (result.data.board as unknown as { groups: Array<{ id: string; displayIndex?: number }> }).groups;
        const byId = new Map(groups.map(g => [g.id, g.displayIndex]));
        expect(byId.get('g2')).toBe(5);
        expect(byId.get('g1')).toBeUndefined();
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
      // The snapshot stub returns the real IPC envelope shape (see
      // `src/main/ipc/board.ipc.ts`).
      installFiloStub({
        'board:load': () => structuredClone(file),
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

    // A nested connection / frame / mindmap-group `boardId` that disagrees with
    // the envelope's `board.id` must be normalized to `board.id` at load time
    // and the board flagged so the repair reaches disk. Trivially produced by
    // copying one board's connections into another file, or a third-party tool
    // writing a stale `boardId`.
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
      board.groups = [
        { id: 'g1', tileIds: ['tile_a'], boardId: 'stale-foreign-id', displayIndex: 1 },
      ];

      // No `recovery:snapshot` stub on purpose: boardId normalization is a
      // benign, deterministic self-heal (no data loss), so it must NOT trip the
      // orphan-prune snapshot / refuse-to-load path. If it did, the missing
      // stub would throw "No stub for channel".
      installFiloStub({ 'board:load': () => structuredClone(file) });

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
        version: 8,
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
          tile_a: { id: 'tile_a', type: 'text', filePath: 'A.md', style: { headerColor: '#fff', bodyColor: '#fff' }, createdAt: now, updatedAt: now },
          tile_b: { id: 'tile_b', type: 'text', filePath: 'B.md', style: { headerColor: '#fff', bodyColor: '#fff' }, createdAt: now, updatedAt: now },
        },
        connections: {},
        frames: [],
      };
      installFiloStub({
        'board:load': () => structuredClone(file),
        'recovery:snapshot': () => ({ ok: true, path: '.filo/recovery/dup.board.json' }),
      });

      const result = await loadBoard('/vault', 'dup.board.json');
      if (!result.ok) throw new Error(`load failed: ${result.error}: ${result.message}`);
      expect(result.orphansPruned).toBe(true);
      const cols = (result.data.board as unknown as { columns: Array<{ tilePlacements: Array<{ tileId: string }> }> }).columns;
      expect(cols[0].tilePlacements.map((p) => p.tileId)).toEqual(['tile_a', 'tile_b']);
    });

    it('refuses a versionless V6 Kanban shape (cardData[]) as no-migration-path', async () => {
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
      installFiloStub({ 'board:load': () => structuredClone(legacy) });
      const result = await loadBoard('/vault', 'legacy.board.json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('no-migration-path');
    });
  });

  describe('loadAllBoards', () => {
    it('aggregates boards, cache, paths, connections, frames', async () => {
      const fileA = validBoardFile('m-a');
      const fileB = validBoardFile('m-b');
      // The connection points at the seeded tile_a so the orphan-ref prune
      // leaves it intact.
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
          rel === 'a.board.json' ? structuredClone(fileA) : structuredClone(fileB),
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
          rel === 'ok.board.json' ? validBoardFile('ok') : null,
      });

      const result = await loadAllBoards('/vault');
      expect(result.boards).toHaveLength(1);
      expect(result.boards[0].id).toBe('ok');
    });

    it('returns failedBoards entries for each unloadable file', async () => {
      installFiloStub({
        'board:list': () => ['ok.board.json', 'broken.board.json'],
        'board:load': (_root: unknown, rel: unknown) =>
          rel === 'ok.board.json' ? validBoardFile('ok') : PARSE_FAILURE,
      });

      const result = await loadAllBoards('/vault');
      expect(result.boards).toHaveLength(1);
      expect(result.failedBoards).toHaveLength(1);
      expect(result.failedBoards[0].path).toBe('broken.board.json');
      expect(result.failedBoards[0].errorKind).toBe('parse-error');
    });

    // Two .board.json files sharing the same board.id must not silently
    // collapse: the second would overwrite cache[id] + paths[id] (the first
    // board unreachable, its saves targeting the survivor's file) and merge its
    // connections/frames into the survivor. Trivially produced by copying a
    // .board.json in the OS file manager or restoring one from backup.
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
          rel === 'first.board.json' ? structuredClone(first) : structuredClone(second),
      });

      const result = await loadAllBoards('/vault');

      // The first file wins and stays reachable under its own path.
      expect(result.boards).toHaveLength(1);
      expect(result.boards[0].id).toBe('dup-id');
      expect(result.paths['dup-id']).toBe('first.board.json');

      // The colliding second file is rejected with its own errorKind.
      expect(result.failedBoards).toHaveLength(1);
      expect(result.failedBoards[0].path).toBe('second.board.json');
      expect(result.failedBoards[0].errorKind).toBe('duplicate-board-id');

      // The loser's connections must NOT have polluted the survivor.
      expect(result.connections.intruder).toBeUndefined();
    });
  });
});
