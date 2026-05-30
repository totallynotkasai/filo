import { describe, it, expect } from 'vitest';
import { freezeLegacyKanbanFolder } from '@renderer/lib/vault/kanbanFolderFreeze';
import type { Board } from '@renderer/schema/index';

/**
 * Phase B / B.1 — Legacy Kanban kanbanFolder freeze at rename time.
 *
 * Phase 2.3 stamps `kanbanFolder` on NEW kanban boards. Boards created
 * before that landed have no field, so `getConventionFolderForBoardType`
 * falls through to `sanitize(name)`. Once renamed, existing cards stay
 * at `Kanban/<oldname>/` while NEW cards land under `Kanban/<newname>/`.
 *
 * `freezeLegacyKanbanFolder` seeds the field from the current name so
 * the convention folder stays put across subsequent renames.
 */

function makeKanban(name: string, kanbanFolder?: string): Board {
  return {
    id: 'b1',
    type: 'kanban',
    name,
    emoji: '',
    createdAt: 0,
    updatedAt: 0,
    settings: {} as never,
    columns: [],
    ...(kanbanFolder !== undefined && { kanbanFolder }),
  } as unknown as Board;
}

function makeMindMap(name: string): Board {
  return {
    id: 'mm',
    type: 'mindmap',
    name,
    emoji: '',
    createdAt: 0,
    updatedAt: 0,
    settings: {} as never,
    placements: {},
    inlineTiles: {},
    connections: [],
    frames: [],
    waypoints: [],
    groups: [],
  } as unknown as Board;
}

describe('freezeLegacyKanbanFolder (Phase B.1)', () => {
  it('seeds kanbanFolder from sanitised current name on a legacy kanban board', () => {
    const board = makeKanban('MyTasks');
    const mutated = freezeLegacyKanbanFolder(board);
    expect(mutated).toBe(true);
    expect((board as Board & { kanbanFolder?: string }).kanbanFolder).toBe('MyTasks');
  });

  it('sanitises illegal filesystem characters when seeding', () => {
    const board = makeKanban('A<b>:c|d');
    const mutated = freezeLegacyKanbanFolder(board);
    expect(mutated).toBe(true);
    expect((board as Board & { kanbanFolder?: string }).kanbanFolder).toBe('Abcd');
  });

  it('does not touch a modern kanban board already carrying kanbanFolder', () => {
    const board = makeKanban('Renamed', 'OriginalFolder');
    const mutated = freezeLegacyKanbanFolder(board);
    expect(mutated).toBe(false);
    expect((board as Board & { kanbanFolder?: string }).kanbanFolder).toBe('OriginalFolder');
  });

  it('treats a whitespace-only kanbanFolder as missing and seeds from name', () => {
    const board = makeKanban('Renamed', '   ');
    const mutated = freezeLegacyKanbanFolder(board);
    expect(mutated).toBe(true);
    expect((board as Board & { kanbanFolder?: string }).kanbanFolder).toBe('Renamed');
  });

  it('does not touch non-kanban boards', () => {
    const board = makeMindMap('SomeMap');
    const mutated = freezeLegacyKanbanFolder(board);
    expect(mutated).toBe(false);
    expect((board as Board & { kanbanFolder?: string }).kanbanFolder).toBeUndefined();
  });
});
