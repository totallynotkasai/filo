/**
 * Phase 0 characterization — invariant: no orphans after random board ops.
 *
 * Property: starting from a default board of each type, applying any
 * sequence drawn from {addTile, removeTile, addConnection, removeConnection,
 * addColumn, removeColumn, addSection, removeSection} leaves
 * `noOrphanPlacementsOrConnections(envelope)` true after every step.
 *
 * The ops in this file are **pure-envelope transitions** that mirror what
 * the cache slices in `boardCacheTiles.ts`, `boardCacheKanban.ts`, and
 * `boardCacheTaskList.ts` would emit when behaving correctly. They are the
 * *invariant target* — a Phase 1+ refactor (notably Phase 2 / bug #2's
 * removeTile dispatch) MUST produce envelopes that pass this invariant.
 * Per-board-type entry-point coverage (the bug #2 capture) lives in
 * `deleteTileEntryPoints.test.ts` so the failure modes there can be
 * inspected one at a time.
 *
 * `noOrphanPlacementsOrConnections` defines orphan in three ways:
 *   1. A placement (or kanban tilePlacement, or task placement) whose
 *      tileId has no matching tileDef entry.
 *   2. A connection (`board.connections` / envelope `connections`) whose
 *      endpoints reference missing tile IDs.
 *   3. A frame whose `tileIds[]` contains an unknown id.
 *
 * Mind Map's `board.inlineTiles` keys count as valid IDs for (2) / (3) —
 * mirroring `V7BoardFileDataSchema.superRefine`'s validIds set
 * (boardFile.ts:60-69).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  MindMapBoardSchema,
  KanbanBoardSchema,
  TaskListBoardSchema,
  DocumentBoardSchema,
  V7BoardFileDataSchema,
  CURRENT_BOARD_FILE_VERSION,
  type Board,
} from '@renderer/schema/index';
import type { BoardType } from '@shared/types';
import { createId } from '@renderer/lib/utils/ids';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';

// ── Envelope factories (mirror boardRegistry, see boardRoundTrip.property.test.ts) ──

function makeMindMap(): V7BoardFileData {
  const now = 0; // deterministic for property tests
  return {
    version: CURRENT_BOARD_FILE_VERSION,
    board: MindMapBoardSchema.parse({
      id: `board_${createId()}`,
      type: 'mindmap',
      name: 'M',
      emoji: '',
      createdAt: now,
      updatedAt: now,
      settings: {},
      placements: {},
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    }),
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function makeKanban(): V7BoardFileData {
  const now = 0;
  return {
    version: CURRENT_BOARD_FILE_VERSION,
    board: KanbanBoardSchema.parse({
      id: `board_${createId()}`,
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: now,
      updatedAt: now,
      settings: {},
      columns: [],
    }),
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function makeTaskList(): V7BoardFileData {
  const now = 0;
  return {
    version: CURRENT_BOARD_FILE_VERSION,
    board: TaskListBoardSchema.parse({
      id: `board_${createId()}`,
      type: 'tasklist',
      name: 'T',
      emoji: '',
      createdAt: now,
      updatedAt: now,
      settings: {},
      tasks: [],
    }),
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function makeDocument(): V7BoardFileData {
  const now = 0;
  return {
    version: CURRENT_BOARD_FILE_VERSION,
    board: DocumentBoardSchema.parse({
      id: `board_${createId()}`,
      type: 'document',
      name: 'D',
      emoji: '',
      createdAt: now,
      updatedAt: now,
      settings: {},
      filePath: `doc_${createId()}.md`,
    }),
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

const FACTORIES: Record<BoardType, () => V7BoardFileData> = {
  mindmap: makeMindMap,
  kanban: makeKanban,
  tasklist: makeTaskList,
  document: makeDocument,
};

// ── Op vocabulary ──────────────────────────────────────────────────────

type Op =
  | { tag: 'addTile' }
  | { tag: 'removeTile' }
  | { tag: 'addConnection' }
  | { tag: 'removeConnection' }
  | { tag: 'addColumn' }
  | { tag: 'removeColumn' }
  | { tag: 'addSection' }
  | { tag: 'removeSection' }
  | { tag: 'addFrame' }
  | { tag: 'removeFrame' };

function mkDef(id: string): V7BoardFileData['tileDefs'][string] {
  return {
    id,
    type: 'text',
    filePath: `tile ${id}.md`,
    style: { headerColor: '#fff', bodyColor: '#fff', borderColor: '' },
    createdAt: 0,
    updatedAt: 0,
  } as V7BoardFileData['tileDefs'][string];
}

function applyOp(env: V7BoardFileData, op: Op): void {
  const board = env.board;
  const type = board.type;
  switch (op.tag) {
    case 'addTile': {
      const id = `tile_${createId()}`;
      env.tileDefs[id] = mkDef(id);
      if (type === 'mindmap') {
        (board as { placements: Record<string, unknown> }).placements[id] = {
          x: 0,
          y: 0,
          width: 240,
          height: 160,
          locked: false,
          faded: false,
        };
      } else if (type === 'kanban') {
        const cols = (board as { columns: Array<{ id: string; tilePlacements: Array<{ tileId: string; position: number }> }> }).columns;
        if (cols.length === 0) {
          // No column to drop into → revert tileDef so we don't create an orphan.
          delete env.tileDefs[id];
          return;
        }
        const col = cols[0];
        col.tilePlacements.push({ tileId: id, position: col.tilePlacements.length });
      } else if (type === 'tasklist') {
        (board as { tasks: Array<{ tileId: string; position: number }> }).tasks.push({
          tileId: id,
          position: (board as { tasks: Array<unknown> }).tasks.length,
        });
      }
      // 'document' — no per-tile placement model; tiles are inline content.
      // We intentionally skip the tileDef insert for documents.
      if (type === 'document') {
        delete env.tileDefs[id];
      }
      return;
    }
    case 'removeTile': {
      const allIds = Object.keys(env.tileDefs);
      if (allIds.length === 0) return;
      const id = allIds[0];
      delete env.tileDefs[id];
      if (type === 'mindmap') {
        delete (board as { placements: Record<string, unknown> }).placements[id];
        delete (board as { inlineTiles: Record<string, unknown> }).inlineTiles[id];
      } else if (type === 'kanban') {
        const cols = (board as { columns: Array<{ tilePlacements: Array<{ tileId: string; position: number }> }> }).columns;
        for (const col of cols) {
          col.tilePlacements = col.tilePlacements.filter((p) => p.tileId !== id);
        }
      } else if (type === 'tasklist') {
        const tl = board as { tasks: Array<{ tileId: string; position: number }> };
        tl.tasks = tl.tasks.filter((p) => p.tileId !== id);
      }
      // Sweep any connection referencing the removed id.
      for (const [connId, c] of Object.entries(env.connections)) {
        if ((c as { fromTileId: string; toTileId: string }).fromTileId === id ||
            (c as { fromTileId: string; toTileId: string }).toTileId === id) {
          delete env.connections[connId];
        }
      }
      // And any frame.tileIds entry.
      for (const frame of env.frames) {
        frame.tileIds = frame.tileIds.filter((tid: string) => tid !== id);
      }
      return;
    }
    case 'addConnection': {
      const ids = Object.keys(env.tileDefs);
      if (ids.length < 2) return;
      const from = ids[0];
      const to = ids[1];
      const cid = `conn_${createId()}`;
      env.connections[cid] = {
        id: cid,
        boardId: board.id,
        fromTileId: from,
        toTileId: to,
        fromBubble: 0,
        toBubble: 0,
        pathColor: '',
        arrowColor: '',
        visibility: 'visible',
        labelVisibility: 'visible',
        label: { text: '', textColor: '', backgroundColor: '', position: 0.5, locked: false },
        createdAt: 0,
        updatedAt: 0,
      } as V7BoardFileData['connections'][string];
      return;
    }
    case 'removeConnection': {
      const keys = Object.keys(env.connections);
      if (keys.length === 0) return;
      delete env.connections[keys[0]];
      return;
    }
    case 'addColumn': {
      if (type !== 'kanban') return;
      const cols = (board as { columns: Array<{ id: string; title: string; position: number; collapsed: boolean; tilePlacements: Array<unknown> }> }).columns;
      cols.push({
        id: `col_${createId()}`,
        title: `Col ${cols.length}`,
        position: cols.length,
        collapsed: false,
        tilePlacements: [],
      });
      return;
    }
    case 'removeColumn': {
      if (type !== 'kanban') return;
      const cols = (board as { columns: Array<{ tilePlacements: Array<{ tileId: string }> }> }).columns;
      if (cols.length === 0) return;
      const removed = cols.shift()!;
      // Removing a column must also remove every tile placement it owned
      // AND every tileDef that those placements were the only reference for.
      for (const placement of removed.tilePlacements) {
        const stillReferenced =
          cols.some((c) => c.tilePlacements.some((p) => p.tileId === placement.tileId));
        if (!stillReferenced) {
          delete env.tileDefs[placement.tileId];
          for (const [connId, c] of Object.entries(env.connections)) {
            if ((c as { fromTileId: string; toTileId: string }).fromTileId === placement.tileId ||
                (c as { fromTileId: string; toTileId: string }).toTileId === placement.tileId) {
              delete env.connections[connId];
            }
          }
        }
      }
      return;
    }
    case 'addSection': {
      if (type !== 'tasklist') return;
      const tl = board as { sections: Array<{ id: string; title: string; position: number; collapsed: boolean }> };
      tl.sections.push({
        id: `section_${createId()}`,
        title: `Section ${tl.sections.length}`,
        position: tl.sections.length,
        collapsed: false,
      });
      return;
    }
    case 'removeSection': {
      if (type !== 'tasklist') return;
      const tl = board as { sections: Array<unknown> };
      if (tl.sections.length === 0) return;
      tl.sections.shift();
      return;
    }
    case 'addFrame': {
      if (type === 'document') return; // documents don't render frames
      env.frames.push({
        id: `frame_${createId()}`,
        boardId: board.id,
        title: 'Frame',
        position: { x: 0, y: 0 },
        size: { width: 200, height: 200 },
        style: {},
        collapsed: false,
        tileIds: [],
        createdAt: 0,
        updatedAt: 0,
      } as V7BoardFileData['frames'][number]);
      return;
    }
    case 'removeFrame': {
      if (env.frames.length === 0) return;
      env.frames.shift();
      return;
    }
  }
}

// ── Orphan-free invariant ──────────────────────────────────────────────

export function findOrphans(env: V7BoardFileData): {
  orphanPlacements: string[];
  orphanConnections: string[];
  orphanFrameIds: string[];
} {
  const tileDefIds = new Set(Object.keys(env.tileDefs));
  const validIds = new Set(tileDefIds);
  const board = env.board;
  if (board.type === 'mindmap') {
    for (const id of Object.keys((board as { inlineTiles?: Record<string, unknown> }).inlineTiles ?? {})) {
      validIds.add(id);
    }
  }

  const orphanPlacements: string[] = [];
  if (board.type === 'mindmap') {
    for (const id of Object.keys((board as { placements: Record<string, unknown> }).placements)) {
      if (!validIds.has(id)) orphanPlacements.push(id);
    }
  } else if (board.type === 'kanban') {
    for (const col of (board as { columns: Array<{ tilePlacements: Array<{ tileId: string }> }> }).columns) {
      for (const p of col.tilePlacements) {
        if (!tileDefIds.has(p.tileId)) orphanPlacements.push(p.tileId);
      }
    }
  } else if (board.type === 'tasklist') {
    for (const p of (board as { tasks: Array<{ tileId: string }> }).tasks) {
      if (!tileDefIds.has(p.tileId)) orphanPlacements.push(p.tileId);
    }
  }

  const orphanConnections: string[] = [];
  for (const [cid, c] of Object.entries(env.connections)) {
    const conn = c as { fromTileId: string; toTileId: string };
    if (!validIds.has(conn.fromTileId) || !validIds.has(conn.toTileId)) {
      orphanConnections.push(cid);
    }
  }

  const orphanFrameIds: string[] = [];
  for (const frame of env.frames) {
    for (const tid of frame.tileIds) {
      if (!validIds.has(tid)) orphanFrameIds.push(`${frame.id}:${tid}`);
    }
  }

  return { orphanPlacements, orphanConnections, orphanFrameIds };
}

function expectNoOrphans(env: V7BoardFileData, ctx: string): void {
  const report = findOrphans(env);
  if (
    report.orphanPlacements.length === 0 &&
    report.orphanConnections.length === 0 &&
    report.orphanFrameIds.length === 0
  ) {
    return;
  }
  throw new Error(
    `[${ctx}] orphan(s) detected: ` +
      `placements=[${report.orphanPlacements.join(',')}] ` +
      `connections=[${report.orphanConnections.join(',')}] ` +
      `frames=[${report.orphanFrameIds.join(',')}]`,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

const BOARD_TYPES: BoardType[] = ['mindmap', 'kanban', 'tasklist', 'document'];

const OP_TAGS: Op['tag'][] = [
  'addTile',
  'removeTile',
  'addConnection',
  'removeConnection',
  'addColumn',
  'removeColumn',
  'addSection',
  'removeSection',
  'addFrame',
  'removeFrame',
];

const opArb = fc.constantFrom(...OP_TAGS).map((tag) => ({ tag }) as Op);
const opSeqArb = fc.array(opArb, { minLength: 0, maxLength: 30 });

describe('Phase 0 characterization — no-orphan invariant under random ops', () => {
  describe('starter sanity — default envelopes have no orphans', () => {
    for (const type of BOARD_TYPES) {
      it(`${type} default envelope is orphan-free`, () => {
        expectNoOrphans(FACTORIES[type](), `default-${type}`);
      });
    }
  });

  describe('per-board-type — every step of a random op sequence holds the invariant', () => {
    for (const type of BOARD_TYPES) {
      it(`${type} — applyOp keeps envelope orphan-free`, () => {
        fc.assert(
          fc.property(opSeqArb, (ops) => {
            const env = FACTORIES[type]();
            ops.forEach((op, i) => {
              applyOp(env, op);
              expectNoOrphans(env, `${type}/step-${i}/${op.tag}`);
            });
          }),
          { numRuns: 40 },
        );
      });
    }
  });

  describe('after every op, the envelope still parses through V7BoardFileDataSchema', () => {
    // Stronger property — not only does the in-memory shape look orphan-
    // free by our hand-written checker, the schema's own cross-check also
    // passes. Catches the case where our checker and the schema disagree.
    for (const type of BOARD_TYPES) {
      it(`${type} — random op sequence yields a schema-valid envelope`, () => {
        fc.assert(
          fc.property(opSeqArb, (ops) => {
            const env = FACTORIES[type]();
            ops.forEach((op) => applyOp(env, op));
            const parsed = V7BoardFileDataSchema.safeParse(JSON.parse(JSON.stringify(env)));
            if (!parsed.success) {
              throw new Error(
                `${type} envelope rejected after ${ops.length} op(s):\n${parsed.error.issues
                  .map((i) => `  ${i.path.join('.')}: ${i.message}`)
                  .join('\n')}`,
              );
            }
          }),
          { numRuns: 30 },
        );
      });
    }
  });
});

// Export `findOrphans` so other characterization tests can reuse the
// invariant definition without duplicating it.
export type { Op };

// Silence the unused-import warning if we ever drop the import (kept around
// because the Phase 2 / Phase 6 collapses may want to import the union).
void ({} as Board);
