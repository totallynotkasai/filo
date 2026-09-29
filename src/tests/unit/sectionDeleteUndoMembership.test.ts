/**
 * Undoing a section delete puts the section's tasks back in it, and leaves
 * every other task in the section it is in now, even when tasks were added
 * or removed elsewhere in between (section starts are absolute indices, so a
 * restore at the recorded start would re-home the wrong tasks).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { DeleteSectionCommand } from '@renderer/commands/index';
import { layoutOf } from '@renderer/lib/tasklist/sectionMembership';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, TaskListSection, TileDefinition } from '@renderer/schema/index';
import type { TaskPlacement } from '@renderer/schema/placement';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function textDef(id: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${id}.md`,
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

/** A owns t1, t2; B owns t3; C owns t4. */
function makeBoard(): BoardFileData {
  return {
    board: {
      id: 'tl', type: 'tasklist', name: 'Tasks', emoji: '', createdAt: 0, updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'manual' },
      sections: [
        { id: 'A', title: 'A', position: 0, collapsed: false },
        { id: 'B', title: 'B', position: 2, collapsed: false },
        { id: 'C', title: 'C', position: 3, collapsed: false },
      ],
      tasks: ['t1', 't2', 't3', 't4'].map((tileId, position) => ({ tileId, position })),
    } as unknown as TaskListBoard,
    tileDefs: { t1: textDef('t1'), t2: textDef('t2'), t3: textDef('t3'), t4: textDef('t4') },
    connections: {},
    frames: [],
  };
}

function board(): TaskListBoard {
  return boardCacheStore.cache.tl!.board as TaskListBoard;
}

function slice(): { sections: TaskListSection[]; tasks: TaskPlacement[]; defs: Record<string, TileDefinition> } {
  return {
    sections: (board().sections ?? []).map((s) => ({ ...s })),
    tasks: (board().tasks ?? []).map((p) => ({ ...p })),
    defs: { ...boardCacheStore.cache.tl!.tileDefs },
  };
}

/** Each section's tasks, in order. */
function owned(): Record<string, string[]> {
  const b = board();
  const { order, sectionOf } = layoutOf(b.sections ?? [], b.tasks ?? []);
  const out: Record<string, string[]> = {};
  for (const id of order) (out[sectionOf[id] ?? '(none)'] ??= []).push(id);
  return out;
}

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

describe('DeleteSectionCommand undo keeps section membership', () => {
  it('keep-tasks: a task added above meanwhile stays in its section; B gets back only its own', () => {
    const before = slice();
    const after = { ...before, sections: before.sections.filter((s) => s.id !== 'B') };
    const cmd = new DeleteSectionCommand('tl', before, after, 'B');
    cmd.execute();
    boardCacheStore.persistAddTaskPlacement('tl', textDef('t5'), 0, undefined, 'A');

    cmd.undo();
    expect(owned()).toEqual({ A: ['t5', 't1', 't2'], B: ['t3'], C: ['t4'] });
  });

  it('delete-tasks: a task removed above meanwhile doesn\'t shift the restored tasks into another section', () => {
    const before = slice();
    const after = {
      sections: before.sections.filter((s) => s.id !== 'B'),
      tasks: before.tasks.filter((p) => p.tileId !== 't3'),
      defs: { t1: before.defs.t1!, t2: before.defs.t2!, t4: before.defs.t4! },
    };
    const cmd = new DeleteSectionCommand('tl', before, after, 'B');
    cmd.execute();
    expect(owned()).toEqual({ A: ['t1', 't2'], C: ['t4'] });
    boardCacheStore.removeTaskPlacement('tl', 't1');

    cmd.undo();
    expect(owned()).toEqual({ A: ['t2'], B: ['t3'], C: ['t4'] });
    expect(boardCacheStore.cache.tl!.tileDefs.t3).toBeTruthy();

    cmd.execute();
    expect(owned()).toEqual({ A: ['t2'], C: ['t4'] });
  });

  it('delete-tasks: a task added above meanwhile stays in its section', () => {
    const before = slice();
    const after = {
      sections: before.sections.filter((s) => s.id !== 'B'),
      tasks: before.tasks.filter((p) => p.tileId !== 't3'),
      defs: { t1: before.defs.t1!, t2: before.defs.t2!, t4: before.defs.t4! },
    };
    const cmd = new DeleteSectionCommand('tl', before, after, 'B');
    cmd.execute();
    boardCacheStore.persistAddTaskPlacement('tl', textDef('t5'), 0, undefined, 'A');

    cmd.undo();
    expect(owned()).toEqual({ A: ['t5', 't1', 't2'], B: ['t3'], C: ['t4'] });
  });
});
