/**
 * Audit5 2.5 (#9) — Task List section commands must be delta-aware.
 *
 * `DeleteSectionCommand` and `ReorderSectionCommand` previously replayed a
 * construction-time snapshot of the WHOLE `tileDefs` / `tasks` / `sections`
 * slice on execute/undo. A task added/edited (or a sibling section
 * renamed/collapsed) between execute and undo — via a non-undoable path or an
 * external frontmatter sync — was silently reverted, and DeleteSection's
 * wholesale `tileDefs` replace lost content edits to OTHER tasks.
 *
 * Both now capture only the affected delta and merge it against the LIVE cache.
 * These tests pin: the deleted/reordered structure round-trips exactly with no
 * interference, AND an out-of-band change between execute and undo survives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { AddSectionCommand, DeleteSectionCommand, ReorderSectionCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, TaskListSection, TileDefinition } from '@renderer/schema/index';
import type { TaskPlacement } from '@renderer/schema/placement';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function textDef(id: string, title: string): TileDefinition {
  return {
    id,
    type: 'text',
    title,
    // headerColor + bodyColor are required by TileStyleSchema (persistAddTaskPlacement
    // validates), so an empty-object style would be rejected.
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
    tags: [],
    contentId: `doc_${id}`,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

/**
 * Board: section A (start index 0, owns t1+t2), section B (start index 2,
 * owns t3). Section `position` is the absolute index into the flat task array.
 */
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
function taskIds(): string[] {
  return (board().tasks ?? []).map((p: TaskPlacement) => p.tileId);
}
function defs(): Record<string, TileDefinition> {
  return boardCacheStore.cache.tl!.tileDefs;
}
function slice() {
  return {
    sections: sections().map((s) => ({ ...s })),
    tasks: (board().tasks ?? []).map((p: TaskPlacement) => ({ ...p })),
    defs: { ...defs() },
  };
}

describe('Audit5 2.5 — DeleteSectionCommand (delta-aware)', () => {
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

  it('keep-tasks: execute drops only the marker; undo restores it without touching tasks', () => {
    const before = slice();
    const after = { sections: [{ ...before.sections[0] }], tasks: before.tasks, defs: before.defs };
    const cmd = new DeleteSectionCommand('tl', before, after, 'B');

    cmd.execute();
    expect(sections().map((s) => s.id)).toEqual(['sec-A']);
    expect(taskIds()).toEqual(['t1', 't2', 't3']); // tasks untouched

    cmd.undo();
    expect(sections().map((s) => s.id)).toEqual(['sec-A', 'sec-B']);
    expect(sections().find((s) => s.id === 'sec-B')?.position).toBe(2);
    expect(taskIds()).toEqual(['t1', 't2', 't3']);
  });

  it('keep-tasks: a task added elsewhere between execute and undo SURVIVES the undo', () => {
    const before = slice();
    const after = { sections: [{ ...before.sections[0] }], tasks: before.tasks, defs: before.defs };
    const cmd = new DeleteSectionCommand('tl', before, after, 'B');

    cmd.execute();
    // Out-of-band add (e.g. quick-add / external sync — not on the undo stack).
    boardCacheStore.persistAddTaskPlacement('tl', textDef('t4', 'Task 4'), 3);
    expect(taskIds()).toContain('t4');

    cmd.undo();
    // Pre-fix the wholesale slice replay reverted t4; the delta restore keeps it.
    expect(taskIds()).toContain('t4');
    expect(defs().t4).toBeTruthy();
    expect(sections().map((s) => s.id)).toEqual(['sec-A', 'sec-B']);
  });

  it('delete-tasks: execute removes the section + its tasks/defs; undo restores all three', () => {
    const before = slice();
    const after = {
      sections: [{ ...before.sections[0] }],
      tasks: [before.tasks[0], before.tasks[1]],
      defs: { t1: before.defs.t1, t2: before.defs.t2 },
    };
    const cmd = new DeleteSectionCommand('tl', before, after, 'B');

    cmd.execute();
    expect(taskIds()).toEqual(['t1', 't2']);
    expect(defs().t3).toBeUndefined();
    expect(sections().map((s) => s.id)).toEqual(['sec-A']);

    cmd.undo();
    expect(taskIds()).toEqual(['t1', 't2', 't3']);
    expect(defs().t3).toBeTruthy();
    expect(sections().map((s) => s.id)).toEqual(['sec-A', 'sec-B']);
    expect(sections().find((s) => s.id === 'sec-B')?.position).toBe(2);
  });

  it('delete-tasks: an EDIT to a sibling task between execute and undo SURVIVES (no wholesale tileDefs clobber)', () => {
    const before = slice();
    const after = {
      sections: [{ ...before.sections[0] }],
      tasks: [before.tasks[0], before.tasks[1]],
      defs: { t1: before.defs.t1, t2: before.defs.t2 },
    };
    const cmd = new DeleteSectionCommand('tl', before, after, 'B');

    cmd.execute();
    // Out-of-band content edit to a SIBLING task (t1, in the surviving section).
    boardCacheStore.updateEntry('tl', {
      tileDefs: { ...defs(), t1: { ...defs().t1, title: 'Edited externally' } },
    });

    cmd.undo();
    // The deleted section's task came back AND the sibling edit was preserved —
    // the pre-fix wholesale `tileDefs` replace reverted t1 to "Task 1".
    expect(defs().t3).toBeTruthy();
    expect(defs().t1.title).toBe('Edited externally');
  });
});

describe('Audit5 2.5 — ReorderSectionCommand (delta-aware)', () => {
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

  it('execute swaps the two adjacent sections + slices; undo (involution) restores the order', () => {
    const before = slice();
    // after = B before A: B@0 (owns t3), A@1 (owns t1,t2); tasks [t3,t1,t2].
    const after = {
      sections: [
        { id: 'sec-B', title: 'B', position: 0, collapsed: false },
        { id: 'sec-A', title: 'A', position: 1, collapsed: false },
      ],
      tasks: [{ tileId: 't3', position: 0 }, { tileId: 't1', position: 1 }, { tileId: 't2', position: 2 }],
    };
    const cmd = new ReorderSectionCommand('tl', before, after);

    cmd.execute();
    expect(sections().map((s) => s.id)).toEqual(['sec-B', 'sec-A']);
    expect(taskIds()).toEqual(['t3', 't1', 't2']);

    cmd.undo();
    expect(sections().map((s) => s.id)).toEqual(['sec-A', 'sec-B']);
    expect(taskIds()).toEqual(['t1', 't2', 't3']);
  });

  it('a task added between execute and undo SURVIVES and lands in its section', () => {
    const before = slice();
    const after = {
      sections: [
        { id: 'sec-B', title: 'B', position: 0, collapsed: false },
        { id: 'sec-A', title: 'A', position: 1, collapsed: false },
      ],
      tasks: [{ tileId: 't3', position: 0 }, { tileId: 't1', position: 1 }, { tileId: 't2', position: 2 }],
    };
    const cmd = new ReorderSectionCommand('tl', before, after);

    cmd.execute(); // order now B, A
    // Out-of-band add into section A (now the trailing section).
    boardCacheStore.persistAddTaskPlacement('tl', textDef('t4', 'Task 4'), 3, undefined, 'sec-A');
    expect(taskIds()).toContain('t4');

    cmd.undo();
    // Order restored (A then B) and the out-of-band t4 survived under A.
    expect(sections().map((s) => s.id)).toEqual(['sec-A', 'sec-B']);
    expect(taskIds()).toContain('t4');
    // t4 sits within A's range (before section B's start index).
    const bStart = sections().find((s) => s.id === 'sec-B')!.position;
    const t4Index = taskIds().indexOf('t4');
    expect(t4Index).toBeLessThan(bStart);
  });
});

/**
 * Audit-6 H1 — multi-slot section drag (3+ sections, 3+ positions changed).
 *
 * The prior Audit5 adjacent-swap encoding only set idA/idB when EXACTLY two
 * positions changed, so a drag across 2+ slots left both empty → execute/undo
 * were silent no-ops and the section snapped back (the move wasn't undoable).
 * The general N-section reorder applies the captured order against the live
 * cache, so a move-first-to-last round-trips through execute → undo → redo.
 */
describe('Audit-6 H1 — ReorderSectionCommand (general N-section reorder)', () => {
  /** Board: A@0 owns t1, B@1 owns t2, C@2 owns t3. */
  function make3SectionBoard(): V7BoardFileData {
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
          { id: 'sec-B', title: 'B', position: 1, collapsed: false },
          { id: 'sec-C', title: 'C', position: 2, collapsed: false },
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

  // before = A,B,C (tasks t1,t2,t3); after = move A to last → B,C,A (tasks t2,t3,t1).
  const before3 = {
    sections: [
      { id: 'sec-A', title: 'A', position: 0, collapsed: false },
      { id: 'sec-B', title: 'B', position: 1, collapsed: false },
      { id: 'sec-C', title: 'C', position: 2, collapsed: false },
    ],
    tasks: [{ tileId: 't1', position: 0 }, { tileId: 't2', position: 1 }, { tileId: 't3', position: 2 }],
  };
  const after3 = {
    sections: [
      { id: 'sec-B', title: 'B', position: 0, collapsed: false },
      { id: 'sec-C', title: 'C', position: 1, collapsed: false },
      { id: 'sec-A', title: 'A', position: 2, collapsed: false },
    ],
    tasks: [{ tileId: 't2', position: 0 }, { tileId: 't3', position: 1 }, { tileId: 't1', position: 2 }],
  };

  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ tl: make3SectionBoard() }, { tl: 'tl.board.json' });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('move-first-to-last round-trips through execute → undo → redo', () => {
    const cmd = new ReorderSectionCommand('tl', before3, after3);

    // Pre-fix this was a silent no-op (3 positions changed → idA/idB empty).
    cmd.execute();
    expect(sections().map((s) => s.id)).toEqual(['sec-B', 'sec-C', 'sec-A']);
    expect(taskIds()).toEqual(['t2', 't3', 't1']);

    cmd.undo();
    expect(sections().map((s) => s.id)).toEqual(['sec-A', 'sec-B', 'sec-C']);
    expect(taskIds()).toEqual(['t1', 't2', 't3']);

    cmd.execute(); // redo
    expect(sections().map((s) => s.id)).toEqual(['sec-B', 'sec-C', 'sec-A']);
    expect(taskIds()).toEqual(['t2', 't3', 't1']);
  });

  it('an out-of-band task added between execute and undo survives the multi-slot undo', () => {
    const cmd = new ReorderSectionCommand('tl', before3, after3);

    cmd.execute(); // order B, C, A
    // Out-of-band add into section C (now the middle section).
    boardCacheStore.persistAddTaskPlacement('tl', textDef('t4', 'Task 4'), 2, undefined, 'sec-C');
    expect(taskIds()).toContain('t4');

    cmd.undo();
    expect(sections().map((s) => s.id)).toEqual(['sec-A', 'sec-B', 'sec-C']);
    // t4 survived and still sits within C's range (at or after C's start index).
    expect(taskIds()).toContain('t4');
    const cStart = sections().find((s) => s.id === 'sec-C')!.position;
    expect(taskIds().indexOf('t4')).toBeGreaterThanOrEqual(cStart);
  });
});

describe('Audit-6 L22 — persistTaskListStructure forces strictly-increasing section positions', () => {
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

  it('de-collides multiple trailing sections whose positions clamp onto taskCount', () => {
    // 3 tasks exist; three sections whose stored positions all EXCEED taskCount
    // (3). The bare Math.min clamp would collapse them onto 3 (a tie), making the
    // task-slice partition order-ambiguous. Strict normalization must return
    // distinct, strictly-increasing positions while preserving sorted order.
    boardCacheStore.persistTaskListStructure('tl', [
      { id: 'x', title: 'X', position: 0, collapsed: false },
      { id: 'y', title: 'Y', position: 5, collapsed: false },
      { id: 'z', title: 'Z', position: 9, collapsed: false },
    ]);
    const secs = sections();
    expect(secs.map((s) => s.id)).toEqual(['x', 'y', 'z']);
    const positions = secs.map((s) => s.position);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('leaves already strictly-increasing in-range positions unchanged', () => {
    boardCacheStore.persistTaskListStructure('tl', [
      { id: 'x', title: 'X', position: 0, collapsed: false },
      { id: 'y', title: 'Y', position: 2, collapsed: false },
    ]);
    expect(sections().map((s) => s.position)).toEqual([0, 2]);
  });
});

describe('Audit-13 L8 — AddSectionCommand deep-clones the section (nested style)', () => {
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

  it('a post-construction mutation of the SOURCE section style does not leak into the snapshot', () => {
    const before = { sections: sections().map((s) => ({ ...s })), tasks: board().tasks ?? [] };
    const newSec: TaskListSection = {
      id: 'sec-C',
      title: 'C',
      position: 4,
      collapsed: false,
      style: { headerColor: '#abc' },
    };
    const after = { sections: [...before.sections, newSec], tasks: before.tasks };
    const cmd = new AddSectionCommand('tl', before, after, 'C');

    // The section is captured BEFORE execute. A shallow copy would alias
    // newSec.style, so this between-construction-and-execute mutation would
    // leak into the persisted section; the deep clone isolates it.
    newSec.style!.headerColor = '#MUTATED';

    cmd.execute();
    const persisted = (board().sections ?? []).find((s) => s.id === 'sec-C');
    expect(persisted?.style?.headerColor).toBe('#abc');
  });
});
