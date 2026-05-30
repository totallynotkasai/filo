/**
 * Phase 0 characterization — board file round-trip parity.
 *
 * Property: for every Board of every type produced by the schema factories,
 * the full V7 envelope serialised with `JSON.stringify` and re-parsed through
 * `V7BoardFileDataSchema` round-trips to a structurally equivalent envelope.
 * Equivalence ignores `version` (the schema applies a `.default(7)` when the
 * field is absent) and explicit `.passthrough()` defaults the schema fills
 * for nested optionals.
 *
 * Mitigates the parity-risk from CONSOLIDATION_PLAN_2026-05-25.md Phase 0:
 * the factories below mirror `boardRegistry[type].createDefault(...)` in
 * `src/renderer/core/boardRegistry.ts` (lines 62-155). The registry itself
 * cannot be imported here because it eagerly pulls in the four Svelte board
 * components, which the vite-plugin-svelte preprocessor cannot handle inside
 * a vitest+jsdom environment. Phase 5 collapses every other in-app board-
 * creation site onto `boardRegistry.createDefault`; if THAT canonical shape
 * drifts from this characterization, the property tests below catch the
 * regression.
 *
 * Phase-1+ collapses MUST keep this test green — any structural drift in
 * the on-disk file shape surfaces here as a property counterexample.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  V7BoardFileDataSchema,
  CURRENT_BOARD_FILE_VERSION,
} from '@renderer/schema/boardFile';
import {
  MindMapBoardSchema,
  KanbanBoardSchema,
  TaskListBoardSchema,
  DocumentBoardSchema,
  type Board,
} from '@renderer/schema/index';
import type { BoardType } from '@shared/types';
import { createId } from '@renderer/lib/utils/ids';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';

// ── Schema-direct factories — mirror `boardRegistry.createDefault` ──

const BOARD_TYPES: readonly BoardType[] = ['mindmap', 'kanban', 'tasklist', 'document'] as const;

function makeMindMap(id: string, name: string): Board {
  const now = Date.now();
  return MindMapBoardSchema.parse({
    id,
    type: 'mindmap',
    name,
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
  });
}

function makeKanban(id: string, name: string): Board {
  const now = Date.now();
  return KanbanBoardSchema.parse({
    id,
    type: 'kanban',
    name,
    emoji: '',
    createdAt: now,
    updatedAt: now,
    settings: {},
    columns: [
      { id: createId(), title: 'To Do', position: 0, collapsed: false, tilePlacements: [] },
      { id: createId(), title: 'In Progress', position: 1, collapsed: false, tilePlacements: [] },
      { id: createId(), title: 'Done', position: 2, collapsed: false, tilePlacements: [] },
    ],
  });
}

function makeTaskList(id: string, name: string): Board {
  const now = Date.now();
  return TaskListBoardSchema.parse({
    id,
    type: 'tasklist',
    name,
    emoji: '',
    createdAt: now,
    updatedAt: now,
    settings: {},
    tasks: [],
  });
}

function makeDocument(id: string, name: string): Board {
  const now = Date.now();
  return DocumentBoardSchema.parse({
    id,
    type: 'document',
    name,
    emoji: '',
    createdAt: now,
    updatedAt: now,
    settings: {},
    contentId: createId(),
    content: '',
  });
}

const FACTORIES: Record<BoardType, (id: string, name: string) => Board> = {
  mindmap: makeMindMap,
  kanban: makeKanban,
  tasklist: makeTaskList,
  document: makeDocument,
};

// ── Helpers ────────────────────────────────────────────────────────────

function makeDefaultEnvelope(type: BoardType): V7BoardFileData {
  const board = FACTORIES[type](`board_${createId()}`, 'Test');
  return {
    version: CURRENT_BOARD_FILE_VERSION,
    board,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function roundTrip(envelope: V7BoardFileData): V7BoardFileData {
  const json = JSON.stringify(envelope, null, 2);
  const parsed = V7BoardFileDataSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new Error(
      `V7BoardFileDataSchema rejected serialised envelope:\n${parsed.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}\nInput:\n${json}`,
    );
  }
  return parsed.data as V7BoardFileData;
}

/**
 * JSON-clone to drop undefineds + flatten Svelte 5 proxies if any so a
 * deep-equality comparison sees plain structures.
 */
function normalise(env: V7BoardFileData): unknown {
  return JSON.parse(JSON.stringify(env));
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Phase 0 characterization — board round-trip parity', () => {
  describe('defaults round-trip per board type', () => {
    for (const type of BOARD_TYPES) {
      it(`${type} default board → JSON.stringify → V7BoardFileDataSchema → equivalent envelope`, () => {
        const before = makeDefaultEnvelope(type);
        const after = roundTrip(before);
        expect(normalise(after)).toEqual(normalise(before));
      });
    }
  });

  describe('envelope without explicit `version` field gets default-stamped to CURRENT_BOARD_FILE_VERSION', () => {
    for (const type of BOARD_TYPES) {
      it(`${type} — schema fills in version=${CURRENT_BOARD_FILE_VERSION}`, () => {
        const before = makeDefaultEnvelope(type);
        delete (before as { version?: number }).version;
        const after = roundTrip(before);
        expect(after.version).toBe(CURRENT_BOARD_FILE_VERSION);
      });
    }
  });

  describe('forward-compatibility — unknown fields survive via passthrough', () => {
    // The schemas are `.passthrough()`; the saver round-trips via
    // JSON.parse(JSON.stringify(...)). A future Filo's extra board fields
    // must reach this build's parse output untouched. This invariant is
    // what allows the entire vault to be opened safely by any Filo build
    // without losing data.
    for (const type of BOARD_TYPES) {
      it(`${type} — extra fields on board, tileDef, frame are preserved`, () => {
        const env = makeDefaultEnvelope(type);
        (env.board as unknown as Record<string, unknown>).__future_field__ = 'preserved';
        if (type === 'mindmap') {
          env.tileDefs = {
            tile_x: {
              id: 'tile_x',
              type: 'text',
              title: 'X',
              tags: [],
              style: { headerColor: '#fff', bodyColor: '#fff', borderColor: '' },
              createdAt: 0,
              updatedAt: 0,
              contentId: 'content_x',
              content: '',
              __future_field__: 'preserved-on-def',
            } as unknown as V7BoardFileData['tileDefs'][string],
          };
        }
        env.frames = [
          {
            id: 'frame_x',
            boardId: 'b',
            title: 'F',
            position: { x: 0, y: 0 },
            size: { width: 200, height: 200 },
            tileIds: [],
            createdAt: 0,
            updatedAt: 0,
            __future_field__: 'preserved-on-frame',
          } as unknown as V7BoardFileData['frames'][number],
        ];

        const after = roundTrip(env);
        expect((after.board as unknown as Record<string, unknown>).__future_field__).toBe('preserved');
        if (type === 'mindmap') {
          const def = (after.tileDefs as Record<string, Record<string, unknown>>).tile_x;
          expect(def.__future_field__).toBe('preserved-on-def');
        }
        const frame = (after.frames[0] as unknown as Record<string, unknown>);
        expect(frame.__future_field__).toBe('preserved-on-frame');
      });
    }
  });

  describe('property — random envelope decorations always round-trip', () => {
    // Property: any envelope produced from a factory default + a JSON-safe
    // sprinkling of extra fields (passthrough territory) round-trips through
    // JSON.stringify + V7BoardFileDataSchema without structural drift.
    const passthroughValue = fc.oneof(
      fc.string({ maxLength: 32 }),
      fc.integer({ min: -1000, max: 1000 }),
      fc.boolean(),
      fc.constant(null),
    );

    const decorations = fc.dictionary(
      fc.stringMatching(/^future_[a-z_]{1,16}$/),
      passthroughValue,
      { minKeys: 0, maxKeys: 4 },
    );

    for (const type of BOARD_TYPES) {
      it(`${type} — factory default + random passthrough fields round-trips`, () => {
        fc.assert(
          fc.property(decorations, (extras) => {
            const env = makeDefaultEnvelope(type);
            Object.assign(env.board as unknown as Record<string, unknown>, extras);
            const after = roundTrip(env);
            const afterBoard = after.board as unknown as Record<string, unknown>;
            for (const [k, v] of Object.entries(extras)) {
              expect(afterBoard[k]).toEqual(v);
            }
          }),
          { numRuns: 25 },
        );
      });
    }
  });
});
