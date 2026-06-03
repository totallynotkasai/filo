/**
 * Audit-6 Phase 5.5 — execute/undo ROUND-TRIP coverage for the Task-List
 * structure commands the `ci:command-roundtrip-coverage` gate requires.
 *
 * Companion to `sectionCommandsDelta.test.ts` (which covers Delete/Reorder).
 * These pin the remaining structure commands: `AddSectionCommand` (a captured
 * delta-add with explicit re-add no-op guards), `RenameSectionCommand` (a
 * live-cache field rename), and `MoveTaskBlockCommand` (a full before/after
 * structure swap moving a task between sections). Each asserts execute changes
 * state, undo reverses it, and redo re-applies it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  AddSectionCommand,
  RenameSectionCommand,
  MoveTaskBlockCommand,
} from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, TaskListSection, TileDefinition } from '@renderer/schema/index';
import type { TaskPlacement } from '@renderer/schema/placement';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function textDef(id: string, title: string): TileDefinition {
  return {
    id,
    type: 'text',
    title,
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
    tags: [],
    contentId: `doc_${id}`,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

/** Section A (start 0, owns t1+t2), section B (start 2, owns t3). */
function makeBoard(): V7BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'manual' },
      sections: [
        { id: 'sec-A', title: 'A', position: 0, collapsed: false },
        { id: 'sec-B', title: 'B', position: 2, collapsed: false },
      ],
      tasks: [
        { tileId: 't1', position: 0 },
        { tileId: 't2', position: 1 },
        { tileId: 't3', position: 2 },
      ],
    } as unknown as TaskListBoard,
    tileDefs: { t1: textDef('t1', 'Task 1'), t2: textDef('t2', 'Task 2'), t3: textDef('t3', 'Task 3') },
    connections: {},
    frames: [],
  };
}

function board(): TaskListBoard {
  return boardCacheStore.cache.tl!.board as TaskListBoard;
}
function sections(): TaskListSection[] {
  return [...(board().sections ?? [])].sort((a, b) => a.position - b.position);
}
function sectionIds(): string[] {
  return sections().map((s) => s.id);
}
function taskIds(): string[] {
  return (board().tasks ?? []).map((p: TaskPlacement) => p.tileId);
}
function slice(): { sections: TaskListSection[]; tasks: TaskPlacement[] } {
  return {
    sections: sections().map((s) => ({ ...s })),
    tasks: (board().tasks ?? []).map((p: TaskPlacement) => ({ ...p })),
  };
}

describe('Audit-6 Phase 5.5 — Task-List structure command round-trips', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ tl: makeBoard() }, { tl: 'tl.board.json' });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('AddSectionCommand: execute appends, undo removes, redo re-adds', () => {
    const before = slice();
    const newSection: TaskListSection = { id: 'sec-C', title: 'C', position: 3, collapsed: false };
    const after = { sections: [...before.sections, newSection], tasks: before.tasks };
    const cmd = new AddSectionCommand('tl', before, after, 'C');

    cmd.execute();
    expect(sectionIds()).toContain('sec-C');
    cmd.undo();
    expect(sectionIds()).not.toContain('sec-C');
    cmd.execute(); // redo
    expect(sectionIds()).toContain('sec-C');
  });

  it('RenameSectionCommand: execute renames, undo restores, redo re-applies', () => {
    const cmd = new RenameSectionCommand('tl', 'sec-A', 'A', 'Alpha');
    cmd.execute();
    expect(sections().find((s) => s.id === 'sec-A')?.title).toBe('Alpha');
    cmd.undo();
    expect(sections().find((s) => s.id === 'sec-A')?.title).toBe('A');
    cmd.execute(); // redo
    expect(sections().find((s) => s.id === 'sec-A')?.title).toBe('Alpha');
  });

  it('MoveTaskBlockCommand: moving t1 from A into B round-trips', () => {
    const before = slice();
    // Move t1 out of A into B: A@0 owns t2; B@1 owns t1,t3; tasks [t2,t1,t3].
    const after = {
      sections: [
        { id: 'sec-A', title: 'A', position: 0, collapsed: false },
        { id: 'sec-B', title: 'B', position: 1, collapsed: false },
      ],
      tasks: [
        { tileId: 't2', position: 0 },
        { tileId: 't1', position: 1 },
        { tileId: 't3', position: 2 },
      ],
    };
    const cmd = new MoveTaskBlockCommand('tl', before, after);

    cmd.execute();
    expect(taskIds()).toEqual(['t2', 't1', 't3']);
    expect(sections().find((s) => s.id === 'sec-B')?.position).toBe(1);

    cmd.undo();
    expect(taskIds()).toEqual(['t1', 't2', 't3']);
    expect(sections().find((s) => s.id === 'sec-B')?.position).toBe(2);

    cmd.execute(); // redo
    expect(taskIds()).toEqual(['t2', 't1', 't3']);
  });
});
