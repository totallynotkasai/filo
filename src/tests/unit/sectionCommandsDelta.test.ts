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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { sectionIdForPlacementIndex } from '@renderer/lib/tasklist/sectionMath';
import { AddSectionCommand, DeleteSectionCommand, ReorderSectionCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, TaskListSection, TileDefinition } from '@renderer/schema/index';
import type { TaskPlacement } from '@renderer/schema/placement';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function textDef(id: string, title: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${title}.md`,
    // headerColor + bodyColor are required by TileStyleSchema (persistAddTaskPlacement
    // validates), so an empty-object style would be rejected.
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
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
    // Out-of-band def edit to a SIBLING task (t1, in the surviving section).
    boardCacheStore.updateEntry('tl', {
      tileDefs: { ...defs(), t1: { ...defs().t1, titleHtml: '<b>Edited externally</b>' } },
    });

    cmd.undo();
    // The deleted section's task came back AND the sibling edit was preserved:
    // a wholesale `tileDefs` replace would revert t1 to its snapshot.
    expect(defs().t3).toBeTruthy();
    expect(defs().t1.titleHtml).toBe('<b>Edited externally</b>');
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

describe('SEC-2 — persistTaskListStructure clamps section positions into [0, taskCount]', () => {
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

  it('PINS trailing sections whose positions exceed taskCount AT taskCount (no position > taskCount)', () => {
    // 3 tasks exist; two sections store positions beyond taskCount (3). They
    // clamp to taskCount and PIN there as empty tail ties — they are NOT bumped
    // to taskCount+1, taskCount+2 (the old L22 behavior, which emitted an
    // invalid `position > taskCount` that can't index `tasks` and misroutes a
    // later add — SEC-1/SEC-2). Sorted array order is preserved; the LAST tied
    // section owns any future tail slot via sectionIdForPlacementIndex.
    boardCacheStore.persistTaskListStructure('tl', [
      { id: 'x', title: 'X', position: 0, collapsed: false },
      { id: 'y', title: 'Y', position: 5, collapsed: false },
      { id: 'z', title: 'Z', position: 9, collapsed: false },
    ]);
    const secs = sections();
    expect(secs.map((s) => s.id)).toEqual(['x', 'y', 'z']);
    expect(secs.map((s) => s.position)).toEqual([0, 3, 3]);
    // SEC-2 invariant: no position exceeds taskCount.
    for (const s of secs) expect(s.position).toBeLessThanOrEqual(3);
  });

  it('leaves already strictly-increasing in-range positions unchanged', () => {
    boardCacheStore.persistTaskListStructure('tl', [
      { id: 'x', title: 'X', position: 0, collapsed: false },
      { id: 'y', title: 'Y', position: 2, collapsed: false },
    ]);
    expect(sections().map((s) => s.position)).toEqual([0, 2]);
  });
});

/**
 * Audit-16 2.2 — DeleteSectionCommand.undo re-inserts the restored marker at
 * its ORIGINAL array slot (anchored on the first surviving successor), not at
 * the end of the sections array.
 *
 * Among sections tied at the same `position` the LAST in array order owns the
 * slice (persistTaskListStructure's documented tie semantics — empty ties are
 * listed BEFORE the populated owner). The pre-fix undo appended the restored
 * section LAST, so deleting an EMPTY section tied with its populated successor
 * and hitting Ctrl+Z silently re-homed every one of the successor's tasks into
 * the restored "empty" section — persisted to .board.json and compounding with
 * later add-to-section ops.
 */
describe('Audit-16 2.2 — DeleteSectionCommand.undo restores a tied section\'s array slot', () => {
  /**
   * Board: A@0 owns t1,t2; E@2 EMPTY, tied with B@2 (E listed before B, so B —
   * last in array order — owns the slice [2, end) = t3).
   */
  function makeTiedBoard(): V7BoardFileData {
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
          { id: 'sec-E', title: 'E', position: 2, collapsed: false },
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

  /** Raw array order (NOT position-sorted) — the tie-ownership discriminator. */
  function rawSectionIds(): string[] {
    return (board().sections ?? []).map((s) => s.id);
  }

  beforeEach(() => {
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ tl: makeTiedBoard() }, { tl: 'tl.board.json' });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('delete EMPTY tied section → undo: the populated sibling keeps its slice (execute→undo AND redo→undo)', () => {
    const before = slice();
    const after = {
      sections: before.sections.filter((s) => s.id !== 'sec-E'),
      tasks: before.tasks,
      defs: before.defs,
    };
    const cmd = new DeleteSectionCommand('tl', before, after, 'E');

    cmd.execute();
    expect(rawSectionIds()).toEqual(['sec-A', 'sec-B']);
    expect(sectionIdForPlacementIndex(board().sections ?? [], 2)).toBe('sec-B');

    cmd.undo();
    // 2.2 — original array order restored: E back BEFORE its tied owner B, so
    // B still owns t3. Pre-fix the marker was appended last → [A, B, E] → the
    // restored "empty" E owned the slice and t3 silently re-homed into it.
    expect(rawSectionIds()).toEqual(['sec-A', 'sec-E', 'sec-B']);
    expect(sectionIdForPlacementIndex(board().sections ?? [], 2)).toBe('sec-B');
    expect(taskIds()).toEqual(['t1', 't2', 't3']);

    cmd.execute(); // redo
    cmd.undo();
    expect(rawSectionIds()).toEqual(['sec-A', 'sec-E', 'sec-B']);
    expect(sectionIdForPlacementIndex(board().sections ?? [], 2)).toBe('sec-B');
  });

  it('delete the POPULATED tied owner (no successor) → undo: append restores the owning tail slot', () => {
    const before = slice();
    // Delete B keep-tasks style: only the marker goes; its tasks stay.
    const after = {
      sections: before.sections.filter((s) => s.id !== 'sec-B'),
      tasks: before.tasks,
      defs: before.defs,
    };
    const cmd = new DeleteSectionCommand('tl', before, after, 'B');

    cmd.execute();
    expect(rawSectionIds()).toEqual(['sec-A', 'sec-E']);

    cmd.undo();
    // B had no array-order successor, so appending IS its original slot —
    // last among the position-2 ties, owning [2, end) again.
    expect(rawSectionIds()).toEqual(['sec-A', 'sec-E', 'sec-B']);
    expect(sectionIdForPlacementIndex(board().sections ?? [], 2)).toBe('sec-B');
  });
});

/**
 * Audit-16 2.3 — persistAddTaskPlacement with a stale/missing targetSectionId
 * falls back to the numeric boundary shift.
 *
 * The SEC-1 rewrite resolves the target section by findIndex and bumps only
 * sections AFTER it in array order — on a miss (the section was deleted
 * between capture and apply: an undo racing an external board reload, or a
 * quick-add aimed at a just-removed section) the condition was false for
 * EVERY section, but the task had already been spliced into `tasks[]`. Every
 * section whose slice starts at/after the insert point ended up off by one,
 * transitively misrouting later adds.
 */
describe('Audit-16 2.3 — persistAddTaskPlacement stale-targetSectionId fallback', () => {
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

  it('shifts later section boundaries by one and keeps every existing section\'s membership', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Insert into A's slice (index 1) targeting a section that no longer exists.
      boardCacheStore.persistAddTaskPlacement('tl', textDef('t4', 'Task 4'), 1, undefined, 'sec-GONE');

      expect(taskIds()).toEqual(['t1', 't4', 't2', 't3']);
      // 2.3 — B's boundary shifted with the insert (pre-fix it stayed at 2,
      // silently stealing t2 into B). A's start is before the insert: unchanged.
      const secs = sections();
      expect(secs.find((s) => s.id === 'sec-A')?.position).toBe(0);
      expect(secs.find((s) => s.id === 'sec-B')?.position).toBe(3);
      // Membership of every existing section is unchanged: B still owns
      // exactly t3; the new task landed in A (whose range the caller named).
      expect(sectionIdForPlacementIndex(board().sections ?? [], 3)).toBe('sec-B');
      expect(sectionIdForPlacementIndex(board().sections ?? [], 1)).toBe('sec-A');
      // The unresolved id is surfaced for diagnosis, not swallowed.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('targetSectionId not found'),
        expect.objectContaining({ targetSectionId: 'sec-GONE' }),
      );
    } finally {
      warnSpy.mockRestore();
    }
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
