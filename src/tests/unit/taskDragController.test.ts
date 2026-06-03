import { describe, it, expect, vi } from 'vitest';
import {
  TaskDragController,
  type SectionItemsSnapshot,
} from '@renderer/lib/tasklist/taskDragController.svelte';
import type {
  TaskPlacement,
  TaskListSection,
} from '@renderer/schema/index';
import type { RowDndItem } from '@renderer/lib/tasklist/blockMove';

/**
 * Phase 6 — TaskDragController integration.
 *
 * The controller's reactive `$state` fields run under Svelte 5's runtime, so
 * we instantiate via the constructor and exercise the `onConsider` /
 * `onFinalize` callbacks directly. Indent / outdent / reorder / cross-section
 * / multi-block / depth-cap / cycle-guard branches each get a focused test.
 *
 * The controller's only environmental dependency is `window.addEventListener`
 * (for ESC + indent tracker). jsdom supplies both.
 */

interface Recording {
  reorder: Array<{
    nextPlacements: TaskPlacement[];
    nextSections: TaskListSection[];
    description: string;
    isMultiDrag: boolean;
    isCrossSection: boolean;
  }>;
  indent: Array<{ tileId: string; newParent: string }>;
  outdent: string[];
  announce: string[];
  toast: Array<{ msg: string; kind?: string }>;
}

function p(tileId: string, position: number): TaskPlacement {
  return { tileId, position };
}

function s(id: string, position: number, title = id): TaskListSection {
  return { id, title, position, collapsed: false };
}

interface RowLikeFx {
  tile: { id: string };
  parent: string;
}

function row(id: string, parent = ''): RowLikeFx {
  return { tile: { id }, parent };
}

function dndEvent(items: RowDndItem[], draggedId: string): CustomEvent {
  return new CustomEvent('dnd', {
    detail: { items, info: { id: draggedId, source: 'pointer', trigger: 'drag' } },
  }) as unknown as CustomEvent;
}

function buildController(opts: {
  rows: RowLikeFx[];
  placements: TaskPlacement[];
  sections: TaskListSection[];
  snapshot: SectionItemsSnapshot;
  selected?: Set<string>;
  isCycleTarget?: (draggedId: string, targetId: string) => boolean;
  isDepthExceeded?: (targetId: string) => boolean;
}): { controller: TaskDragController; rec: Recording } {
  const rec: Recording = {
    reorder: [],
    indent: [],
    outdent: [],
    announce: [],
    toast: [],
  };
  const controller = new TaskDragController({
    getRows: () => opts.rows,
    getPlacements: () => opts.placements,
    getSections: () => opts.sections,
    getSelectedTaskIds: () => opts.selected ?? new Set(),
    getSnapshot: () => opts.snapshot,
    isCycleTarget: opts.isCycleTarget ?? (() => false),
    isDepthExceeded: opts.isDepthExceeded ?? (() => false),
    commitIndent: (tileId, newParent) => {
      rec.indent.push({ tileId, newParent });
    },
    commitOutdent: (tileId) => {
      rec.outdent.push(tileId);
    },
    commitReorder: (args) => {
      rec.reorder.push(args);
    },
    announce: (msg) => {
      rec.announce.push(msg);
    },
    toast: (msg, kind) => {
      rec.toast.push({ msg, kind });
    },
  });
  return { controller, rec };
}

describe('TaskDragController — same-section reorder', () => {
  it('commits a single-row reorder and announces', () => {
    const placements = [p('a', 0), p('b', 1), p('c', 2)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const { controller, rec } = buildController({
      rows: [row('a'), row('b'), row('c')],
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();

    // Simulate "drag b above a" → items: [b, a, c]
    controller.onConsiderRows('S', dndEvent([{ id: 'b' }, { id: 'a' }, { id: 'c' }], 'b'));
    controller.onFinalizeRows('S', dndEvent([{ id: 'b' }, { id: 'a' }, { id: 'c' }], 'b'));

    expect(rec.reorder).toHaveLength(1);
    expect(rec.reorder[0].nextPlacements.map((x) => x.tileId)).toEqual(['b', 'a', 'c']);
    expect(rec.reorder[0].isCrossSection).toBe(false);
    expect(rec.reorder[0].isMultiDrag).toBe(false);
    expect(rec.reorder[0].description).toBe('Reorder task');
    // Phase 7.4 announcement form: "Dropped task X at position N in section S".
    expect(rec.announce.some((m) => /^Dropped task .* at position \d+ in /.test(m))).toBe(true);
  });
});

describe('TaskDragController — cross-section drag', () => {
  it('flags isCrossSection=true when source and destination differ', () => {
    const placements = [p('a1', 0), p('a2', 1), p('b1', 2)];
    const sections = [s('A', 0), s('B', 2)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: {
        A: [{ id: 'a1' }, { id: 'a2' }],
        B: [{ id: 'b1' }],
      },
      displaySectionIds: ['A', 'B'],
      leadingSectionId: '__lead',
    };
    const { controller, rec } = buildController({
      rows: [row('a1'), row('a2'), row('b1')],
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();

    // First consider — drag starts in A (a2 picked up).
    controller.onConsiderRows('A', dndEvent([{ id: 'a1' }], 'a2'));
    // Destination consider — a2 lands at top of B.
    controller.onConsiderRows('B', dndEvent([{ id: 'a2' }, { id: 'b1' }], 'a2'));
    // Finalize on destination.
    controller.onFinalizeRows('B', dndEvent([{ id: 'a2' }, { id: 'b1' }], 'a2'));

    expect(rec.reorder).toHaveLength(1);
    expect(rec.reorder[0].isCrossSection).toBe(true);
    expect(rec.reorder[0].description).toBe('Move task');
  });
});

describe('TaskDragController — indent / outdent (single, same-section)', () => {
  function makeIndentFixture() {
    const placements = [p('a', 0), p('b', 1)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    return { placements, sections, snap };
  }

  it('commits an indent when horizontal-rightward gesture lands on a sibling', () => {
    const { placements, sections, snap } = makeIndentFixture();
    const { controller, rec } = buildController({
      rows: [row('a'), row('b')],
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();

    // Arm the drag handle so the indent tracker captures the start position.
    controller.armRow('S', 'a', 0, 0);

    // First consider — install indent tracker via dragstart sentinel.
    controller.onConsiderRows('S', dndEvent([{ id: 'b' }, { id: 'a' }], 'a'));

    // Simulate the user dragging horizontally onto row 'b'.
    const target = document.createElement('div');
    target.dataset.taskId = 'b';
    document.body.appendChild(target);
    const evt = new PointerEvent('pointermove', { clientX: 100, clientY: 5, bubbles: true });
    Object.defineProperty(evt, 'target', { value: target });
    window.dispatchEvent(evt);

    // Finalize on the same section.
    controller.onFinalizeRows('S', dndEvent([{ id: 'b' }, { id: 'a' }], 'a'));

    expect(rec.indent).toEqual([{ tileId: 'a', newParent: 'b' }]);
    expect(rec.reorder).toHaveLength(0);
    expect(rec.announce.some((m) => /^Indented task /.test(m))).toBe(true);

    target.remove();
  });

  it('rejects indent when target is at depth cap and toasts the user', () => {
    const { placements, sections, snap } = makeIndentFixture();
    const { controller, rec } = buildController({
      rows: [row('a'), row('b')],
      placements,
      sections,
      snapshot: snap,
      isDepthExceeded: (id) => id === 'b',
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'a', 0, 0);
    controller.onConsiderRows('S', dndEvent([{ id: 'b' }, { id: 'a' }], 'a'));

    const target = document.createElement('div');
    target.dataset.taskId = 'b';
    document.body.appendChild(target);
    const evt = new PointerEvent('pointermove', { clientX: 100, clientY: 5, bubbles: true });
    Object.defineProperty(evt, 'target', { value: target });
    window.dispatchEvent(evt);

    controller.onFinalizeRows('S', dndEvent([{ id: 'b' }, { id: 'a' }], 'a'));

    expect(rec.indent).toHaveLength(0);
    expect(rec.toast.some((t) => /Maximum subtask depth/i.test(t.msg))).toBe(true);
    target.remove();
  });

  it('rejects indent when target is a transitive descendant of dragged (cycle guard)', () => {
    const { placements, sections, snap } = makeIndentFixture();
    // Rows are both top-level — `resolveDragBlockIds` returns [draggedId] only,
    // so the single-row indent branch IS reached. The cycle check callback
    // models the calling component's check that target is in dragged's subtree.
    const { controller, rec } = buildController({
      rows: [row('a'), row('b')],
      placements,
      sections,
      snapshot: snap,
      isCycleTarget: (draggedId, targetId) => draggedId === 'a' && targetId === 'b',
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'a', 0, 0);
    controller.onConsiderRows('S', dndEvent([{ id: 'b' }, { id: 'a' }], 'a'));

    const target = document.createElement('div');
    target.dataset.taskId = 'b';
    document.body.appendChild(target);
    const evt = new PointerEvent('pointermove', { clientX: 100, clientY: 5, bubbles: true });
    Object.defineProperty(evt, 'target', { value: target });
    window.dispatchEvent(evt);

    controller.onFinalizeRows('S', dndEvent([{ id: 'b' }, { id: 'a' }], 'a'));

    expect(rec.indent).toHaveLength(0);
    expect(rec.toast.some((t) => /Cannot indent under own subtask/i.test(t.msg))).toBe(true);
    target.remove();
  });

  it('commits an outdent when leftward gesture on a row with a parent', () => {
    const placements = [p('a', 0), p('b', 1)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const { controller, rec } = buildController({
      rows: [row('a'), row('b', 'a')], // b is a subtask of a
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'b', 100, 0);
    controller.onConsiderRows('S', dndEvent([{ id: 'a' }, { id: 'b' }], 'b'));

    // Drag leftward 100px.
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 0, clientY: 0, bubbles: true }),
    );

    controller.onFinalizeRows('S', dndEvent([{ id: 'a' }, { id: 'b' }], 'b'));

    expect(rec.outdent).toEqual(['b']);
    expect(rec.reorder).toHaveLength(0);
    expect(rec.announce.some((m) => /^Outdented task /.test(m))).toBe(true);
  });

  it('outdent on a top-level row is a no-op (no commit, no announce)', () => {
    const placements = [p('a', 0), p('b', 1)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const { controller, rec } = buildController({
      rows: [row('a'), row('b')], // b has NO parent
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'b', 100, 0);
    controller.onConsiderRows('S', dndEvent([{ id: 'a' }, { id: 'b' }], 'b'));
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 0, clientY: 0, bubbles: true }),
    );
    controller.onFinalizeRows('S', dndEvent([{ id: 'a' }, { id: 'b' }], 'b'));

    expect(rec.outdent).toHaveLength(0);
    expect(rec.reorder).toHaveLength(0);
  });
});

describe('TaskDragController — pointerdown snapshot (Phase 1 fix)', () => {
  it('armRow snapshots dragBlockIds from current selection at pointerdown', () => {
    const placements = [p('a', 0), p('b', 1), p('c', 2)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const selected = new Set(['a', 'b']);
    const { controller } = buildController({
      rows: [row('a'), row('b'), row('c')],
      placements,
      sections,
      snapshot: snap,
      selected,
    });
    controller.syncFromSnapshot();

    controller.armRow('S', 'a', 0, 0);

    // Block is captured immediately, before any consider event fires.
    expect(controller.dragBlockIds.sort()).toEqual(['a', 'b']);
  });

  it('preserves the pointerdown-time block even if selection mutates mid-drag', () => {
    const placements = [p('a', 0), p('b', 1), p('c', 2)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    // Mutable selection ref — the controller reads it via the getter, but
    // armRow snapshots it into dragBlockIds so later mutations don't reach
    // the drag transaction.
    let selected = new Set(['a', 'b']);
    const rec: Recording = { reorder: [], indent: [], outdent: [], announce: [], toast: [] };
    const controller = new TaskDragController({
      getRows: () => [row('a'), row('b'), row('c')],
      getPlacements: () => placements,
      getSections: () => sections,
      getSelectedTaskIds: () => selected,
      getSnapshot: () => snap,
      isCycleTarget: () => false,
      isDepthExceeded: () => false,
      commitIndent: () => {},
      commitOutdent: () => {},
      commitReorder: (args) => rec.reorder.push(args),
      announce: () => {},
      toast: () => {},
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'a', 0, 0);
    expect(controller.dragBlockIds.sort()).toEqual(['a', 'b']);

    // Selection clears mid-gesture (would normally happen if some reactive
    // path raced with the drag). The committed block must NOT shrink to one.
    selected = new Set();

    controller.onConsiderRows('S', dndEvent([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'a'));
    controller.onFinalizeRows('S', dndEvent([{ id: 'c' }, { id: 'a' }, { id: 'b' }], 'a'));

    expect(rec.reorder).toHaveLength(1);
    expect(rec.reorder[0].isMultiDrag).toBe(true);
  });

  it('armRow enables every section dndzone, not just the source', () => {
    const placements = [p('a', 0), p('b', 1)];
    const sections = [s('S1', 0), s('S2', 1)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S1: [{ id: 'a' }], S2: [{ id: 'b' }] },
      displaySectionIds: ['S1', 'S2'],
      leadingSectionId: '__lead',
    };
    const { controller } = buildController({
      rows: [row('a'), row('b')],
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();

    // Both sections start disabled (default).
    expect(controller.rowDragDisabledBySection.S1).toBe(true);
    expect(controller.rowDragDisabledBySection.S2).toBe(true);

    controller.armRow('S1', 'a', 0, 0);

    // Both zones are now enabled so a cross-section drop into S2 isn't
    // silently rejected by the library's `dragDisabled` check.
    expect(controller.rowDragDisabledBySection.S1).toBe(false);
    expect(controller.rowDragDisabledBySection.S2).toBe(false);
  });
});

describe('TaskDragController — multi-block drag', () => {
  it('uses moveTaskBlock-style commit and reports the correct block size', () => {
    const placements = [p('a', 0), p('b', 1), p('c', 2)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const selected = new Set(['a', 'b']); // multi-select
    const { controller, rec } = buildController({
      rows: [row('a'), row('b'), row('c')],
      placements,
      sections,
      snapshot: snap,
      selected,
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'a', 0, 0);

    controller.onConsiderRows('S', dndEvent([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'a'));
    controller.onFinalizeRows('S', dndEvent([{ id: 'c' }, { id: 'a' }, { id: 'b' }], 'a'));

    expect(rec.reorder).toHaveLength(1);
    expect(rec.reorder[0].isMultiDrag).toBe(true);
    expect(rec.reorder[0].description).toMatch(/Reorder 2 tasks|Move 2 tasks/);
  });

  it('never indents on multi-drag even if horizontal gesture would normally classify as indent', () => {
    const placements = [p('a', 0), p('b', 1)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const selected = new Set(['a', 'b']);
    const { controller, rec } = buildController({
      rows: [row('a'), row('b')],
      placements,
      sections,
      snapshot: snap,
      selected,
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'a', 0, 0);
    controller.onConsiderRows('S', dndEvent([{ id: 'a' }, { id: 'b' }], 'a'));

    const target = document.createElement('div');
    target.dataset.taskId = 'b';
    document.body.appendChild(target);
    const evt = new PointerEvent('pointermove', { clientX: 200, clientY: 5, bubbles: true });
    Object.defineProperty(evt, 'target', { value: target });
    window.dispatchEvent(evt);

    controller.onFinalizeRows('S', dndEvent([{ id: 'a' }, { id: 'b' }], 'a'));

    expect(rec.indent).toHaveLength(0);
    // Multi-drag drops fall through to the reorder branch.
    expect(rec.reorder).toHaveLength(1);
    expect(rec.reorder[0].isMultiDrag).toBe(true);
    target.remove();
  });
});

describe('TaskDragController — stale tile guard', () => {
  it('bails with a toast when the dragged tile was removed before drop', () => {
    const placements = [p('a', 0), p('b', 1)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    let placementsLive: TaskPlacement[] = [...placements];
    const rec: Recording = {
      reorder: [],
      indent: [],
      outdent: [],
      announce: [],
      toast: [],
    };
    const controller = new TaskDragController({
      getRows: () => [row('a'), row('b')],
      getPlacements: () => placementsLive,
      getSections: () => sections,
      getSelectedTaskIds: () => new Set(),
      getSnapshot: () => snap,
      isCycleTarget: () => false,
      isDepthExceeded: () => false,
      commitIndent: (tileId, newParent) => rec.indent.push({ tileId, newParent }),
      commitOutdent: (tileId) => rec.outdent.push(tileId),
      commitReorder: (args) => rec.reorder.push(args),
      announce: (m) => rec.announce.push(m),
      toast: (msg, kind) => rec.toast.push({ msg, kind }),
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'a', 0, 0);
    controller.onConsiderRows('S', dndEvent([{ id: 'b' }, { id: 'a' }], 'a'));

    // Simulate concurrent removal of 'a' between consider and finalize.
    placementsLive = placementsLive.filter((p) => p.tileId !== 'a');

    controller.onFinalizeRows('S', dndEvent([{ id: 'b' }, { id: 'a' }], 'a'));

    expect(rec.reorder).toHaveLength(0);
    expect(rec.toast.some((t) => /removed before the drop/i.test(t.msg))).toBe(true);
  });
});

describe('TaskDragController — ESC cancel', () => {
  it('treats ESC during drag as a no-commit cancel and announces "Drop cancelled"', () => {
    const placements = [p('a', 0), p('b', 1)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const { controller, rec } = buildController({
      rows: [row('a'), row('b')],
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'a', 0, 0);
    controller.onConsiderRows('S', dndEvent([{ id: 'b' }, { id: 'a' }], 'a'));

    // User hits Escape. The controller's keydown handler dispatches a
    // synthetic pointerup which dnd-action normally responds to; we
    // simulate the resulting finalize manually.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    controller.onFinalizeRows('S', dndEvent([{ id: 'a' }, { id: 'b' }], 'a'));

    expect(rec.reorder).toHaveLength(0);
    expect(rec.announce).toContain('Drop cancelled');
  });
});

describe('TaskDragController — drag state lifecycle', () => {
  it('clears dragTileId and dragBlockIds after finalize', () => {
    const placements = [p('a', 0)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const { controller } = buildController({
      rows: [row('a')],
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'a', 0, 0);
    controller.onConsiderRows('S', dndEvent([{ id: 'a' }], 'a'));
    expect(controller.dragTileId).toBe('a');
    controller.onFinalizeRows('S', dndEvent([{ id: 'a' }], 'a'));
    expect(controller.dragTileId).toBeNull();
    expect(controller.dragBlockIds).toEqual([]);
  });

  it('cancelDrag() resets state without committing', () => {
    const placements = [p('a', 0)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const { controller, rec } = buildController({
      rows: [row('a')],
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'a', 0, 0);
    controller.onConsiderRows('S', dndEvent([{ id: 'a' }], 'a'));
    controller.cancelDrag();
    expect(controller.dragTileId).toBeNull();
    expect(rec.reorder).toHaveLength(0);
  });
});

describe('TaskDragController — syncFromSnapshot', () => {
  it('mirrors snapshot into rowItemsBySection when idle', () => {
    const placements = [p('a', 0)];
    const sections = [s('S', 0)];
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const { controller } = buildController({
      rows: [row('a')],
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();
    expect(controller.rowItemsBySection.S).toEqual([{ id: 'a' }]);
  });

  it('does NOT mirror while a drag is in flight (would clobber dndzone state)', () => {
    const placements = [p('a', 0), p('b', 1)];
    const sections = [s('S', 0)];
    let snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }, { id: 'b' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const { controller } = buildController({
      rows: [row('a'), row('b')],
      placements,
      sections,
      snapshot: snap,
    });
    controller.syncFromSnapshot();
    controller.armRow('S', 'a', 0, 0);
    controller.onConsiderRows('S', dndEvent([{ id: 'b' }, { id: 'a' }], 'a'));

    // Change the snapshot mid-drag — sync must be a no-op.
    snap = { ...snap, itemsBySection: { S: [{ id: 'a' }] } };
    controller.syncFromSnapshot();

    // rowItemsBySection should still reflect the in-flight items.
    expect(controller.rowItemsBySection.S.map((x) => x.id)).toEqual(['b', 'a']);
    controller.cancelDrag();
  });
});

describe('TaskDragController — L16 pointerup cleanup', () => {
  it('detaches the armRow pointerup on cancelDrag() even when no drag started', () => {
    const snap: SectionItemsSnapshot = {
      itemsBySection: { S: [{ id: 'a' }] },
      displaySectionIds: ['S'],
      leadingSectionId: '__lead',
    };
    const { controller } = buildController({
      rows: [row('a')],
      placements: [p('a', 0)],
      sections: [s('S', 0)],
      snapshot: snap,
    });
    controller.syncFromSnapshot();

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    // Pointer pressed on the drag handle — arms a window pointerup — but the
    // gesture never begins (no onConsiderRows), so dragTileId stays null.
    controller.armRow('S', 'a', 10, 10);
    const armed = addSpy.mock.calls.find(([type]) => type === 'pointerup');
    expect(armed, 'armRow did not arm a pointerup').toBeTruthy();
    const handler = armed![1];

    // Unmount path: cancelDrag must detach the listener even though no drag
    // began (the early `dragTileId === null` return previously skipped cleanup).
    controller.cancelDrag();
    expect(removeSpy).toHaveBeenCalledWith('pointerup', handler);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
