/**
 * Zod 4's `.int()` means SAFE integer: anything above 2^53 − 1 fails. That
 * is accepted (KNOWN_LIMITATIONS #23): such a position can't be represented
 * exactly anyway, and every reorder would corrupt it. These tests pin the
 * boundary so a future Zod change is noticed, and pin that an affected board
 * is refused cleanly (failedBoards → recovery snapshot) rather than crashing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { KanbanTilePlacementSchema, TaskPlacementSchema } from '@renderer/schema/placement';
import { KanbanBoardSchema, TaskListBoardSchema } from '@renderer/schema/board';
import { TagsFileSchema } from '@renderer/schema/tagsFile';
import { loadAllBoards } from '@renderer/lib/boards/boardLoader';

const MAX = Number.MAX_SAFE_INTEGER; // 2^53 − 1
const OVER = 2 ** 53;

function kanbanBoard(column: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'kb',
    name: 'K',
    emoji: '',
    type: 'kanban',
    settings: {},
    createdAt: 0,
    updatedAt: 0,
    columns: [{ id: 'c1', title: 'Todo', position: 0, collapsed: false, tilePlacements: [], ...column }],
  };
}

function taskListBoard(sectionPosition: number): Record<string, unknown> {
  return {
    id: 'tl',
    name: 'T',
    emoji: '',
    type: 'tasklist',
    settings: {},
    createdAt: 0,
    updatedAt: 0,
    tasks: [],
    sections: [{ id: 's1', title: 'One', position: sectionPosition, collapsed: false }],
  };
}

describe('integer fields accept 2^53 − 1 and reject 2^53', () => {
  it('Kanban and Task List placement position', () => {
    for (const schema of [KanbanTilePlacementSchema, TaskPlacementSchema]) {
      expect(schema.safeParse({ tileId: 't', position: MAX }).success).toBe(true);
      expect(schema.safeParse({ tileId: 't', position: OVER }).success).toBe(false);
    }
  });

  it('Kanban column wipLimit', () => {
    expect(KanbanBoardSchema.safeParse(kanbanBoard({ wipLimit: MAX })).success).toBe(true);
    expect(KanbanBoardSchema.safeParse(kanbanBoard({ wipLimit: OVER })).success).toBe(false);
  });

  it('Task List section position', () => {
    expect(TaskListBoardSchema.safeParse(taskListBoard(MAX)).success).toBe(true);
    expect(TaskListBoardSchema.safeParse(taskListBoard(OVER)).success).toBe(false);
  });

  it('tags.json version', () => {
    expect(TagsFileSchema.safeParse({ version: MAX, tags: {} }).success).toBe(true);
    expect(TagsFileSchema.safeParse({ version: OVER, tags: {} }).success).toBe(false);
  });
});

describe('a board with a position of 1e20 is refused, not loaded or crashed', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loadAllBoards routes it to failedBoards as schema-invalid', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = {
      version: 8,
      board: kanbanBoard({ tilePlacements: [{ tileId: 't1', position: 1e20 }] }),
      tileDefs: {},
      connections: {},
      frames: [],
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'board:list') return ['Huge.board.json'];
      if (channel === 'board:load') return JSON.parse(JSON.stringify(file)) as unknown;
      return { ok: true };
    });
    (window as unknown as { filo: unknown }).filo = { invoke, on: () => () => {}, send: () => {} };

    const result = await loadAllBoards('/vault');
    expect(result.boards).toHaveLength(0);
    expect(result.failedBoards).toEqual([
      expect.objectContaining({ path: 'Huge.board.json', errorKind: 'schema-invalid' }),
    ]);
    // Refused boards are never written back.
    expect(invoke.mock.calls.some(([ch]) => String(ch).startsWith('board:save'))).toBe(false);
  });

  it('vault open snapshots schema-invalid boards into .filo/recovery/', () => {
    const src = readFileSync(
      resolve(__dirname, '..', '..', 'renderer', 'lib', 'vault', 'vaultCandidate.ts'),
      'utf8',
    );
    const kinds = /SNAPSHOT_FAILED_BOARD_KINDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '';
    expect(kinds).toContain("'schema-invalid'");
  });
});
