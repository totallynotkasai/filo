import { describe, it, expect } from 'vitest';
import {
  collectDescendantIds,
  getTaskDepth,
  resolveDragBlockIds,
  spliceBlockContiguous,
  rebuildPlacementsFromDndItems,
  type RowLike,
  type RowDndItem,
} from '@renderer/lib/tasklist/blockMove';
import type { TaskPlacement, TaskListSection } from '@renderer/schema/index';

/**
 * Phase 6 — block math for Task List drag operations. Helpers are pure;
 * fixtures are minimal row-like objects + flat TaskPlacement arrays.
 */

function r(id: string, parent = ''): RowLike {
  return { tile: { id }, parent };
}

function p(tileId: string, position = 0): TaskPlacement {
  return { tileId, position };
}

function s(id: string, position: number, title = id): TaskListSection {
  return { id, title, position, collapsed: false };
}

describe('collectDescendantIds', () => {
  it('returns just the tile when it has no children', () => {
    const rows = [r('a')];
    expect(collectDescendantIds(rows, 'a')).toEqual(['a']);
  });

  it('walks transitive descendants in DFS order', () => {
    const rows = [r('a'), r('b', 'a'), r('c', 'b'), r('d', 'a')];
    // DFS from 'a' → a, then b's subtree (b, c), then d.
    expect(collectDescendantIds(rows, 'a')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns empty when tile is not in rows', () => {
    expect(collectDescendantIds([r('a')], 'missing')).toEqual(['missing']);
  });

  it('guards against parent-chain cycles', () => {
    // Corrupt data: a.parent → b, b.parent → a — descendants must terminate.
    const rows = [r('a', 'b'), r('b', 'a')];
    const out = collectDescendantIds(rows, 'a');
    expect(out).toContain('a');
    expect(out.length).toBeLessThan(10); // no infinite recursion
  });
});

describe('getTaskDepth', () => {
  it('returns 0 for a top-level tile', () => {
    expect(getTaskDepth([r('a')], 'a')).toBe(0);
  });

  it('returns 1 for a direct subtask', () => {
    expect(getTaskDepth([r('a'), r('b', 'a')], 'b')).toBe(1);
  });

  it('returns 2 for a sub-subtask', () => {
    const rows = [r('a'), r('b', 'a'), r('c', 'b')];
    expect(getTaskDepth(rows, 'c')).toBe(2);
  });

  it('returns Infinity when a cycle is detected (>= 8 hops)', () => {
    // 8-link cycle: a→b→c→d→e→f→g→h→a (safety check caps at 8).
    const rows = [
      r('a', 'h'), r('b', 'a'), r('c', 'b'), r('d', 'c'),
      r('e', 'd'), r('f', 'e'), r('g', 'f'), r('h', 'g'),
    ];
    expect(getTaskDepth(rows, 'a')).toBe(Infinity);
  });
});

describe('resolveDragBlockIds', () => {
  it('expands a single seed to include its descendants', () => {
    const rows = [r('a'), r('b', 'a'), r('c', 'b')];
    const placements = [p('a'), p('b'), p('c')];
    expect(resolveDragBlockIds(rows, placements, ['a'])).toEqual(['a', 'b', 'c']);
  });

  it('orders the result to match placements order', () => {
    const rows = [r('a'), r('b', 'a'), r('x')];
    const placements = [p('b'), p('x'), p('a')]; // a is last in placements
    const out = resolveDragBlockIds(rows, placements, ['a']);
    expect(out).toEqual(['b', 'a']); // placements order, only block members
  });

  it('deduplicates when multi-select seeds overlap (e.g. parent + child)', () => {
    const rows = [r('a'), r('b', 'a')];
    const placements = [p('a'), p('b')];
    expect(resolveDragBlockIds(rows, placements, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns empty list when seeds are absent from placements', () => {
    expect(resolveDragBlockIds([], [], ['missing'])).toEqual([]);
  });
});

describe('spliceBlockContiguous', () => {
  it('returns input unchanged for solo drag (blockIds.length < 2)', () => {
    const placements = [p('a'), p('b')];
    expect(spliceBlockContiguous(placements, 'a', ['a'])).toBe(placements);
  });

  it('returns input unchanged when anchor is absent', () => {
    const placements = [p('a'), p('b')];
    expect(spliceBlockContiguous(placements, 'missing', ['a', 'b'])).toBe(placements);
  });

  it('moves non-anchor block members to flank the anchor', () => {
    // Anchor 'b' at idx 1; non-anchor members 'a', 'c' must move to be
    // contiguous next to it.
    const placements = [p('a'), p('b'), p('x'), p('c'), p('y')];
    const out = spliceBlockContiguous(placements, 'b', ['b', 'a', 'c']);
    // Preserves input order of block members: a appears before b before c.
    expect(out.map((x) => x.tileId)).toEqual(['a', 'b', 'c', 'x', 'y']);
    expect(out.map((x) => x.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps block order relative to input placements', () => {
    const placements = [p('x'), p('c'), p('y'), p('b'), p('a'), p('z')];
    const out = spliceBlockContiguous(placements, 'b', ['b', 'a', 'c']);
    // 'c' is at idx 1, 'b' at idx 3, 'a' at idx 4. Anchor lives at idx 3.
    // blockBeforeAnchor = 1 ('c'). Insertion = 3 - 1 = 2 in remaining.
    // remaining = [x, y, z] → insert block [c, b, a] at idx 2 → [x, y, c, b, a, z]
    expect(out.map((x) => x.tileId)).toEqual(['x', 'y', 'c', 'b', 'a', 'z']);
  });
});

describe('rebuildPlacementsFromDndItems', () => {
  function item(id: string): RowDndItem {
    return { id };
  }

  it('reassembles placements from per-section item mirrors', () => {
    const placements = [p('a1'), p('a2'), p('b1'), p('b2')];
    const sections = [s('A', 0), s('B', 2)];
    const out = rebuildPlacementsFromDndItems({
      placements,
      sections,
      displaySectionIds: ['A', 'B'],
      leadingSectionId: '__leading',
      itemsBySection: {
        A: [item('a2'), item('a1')], // reorder within A
        B: [item('b1'), item('b2')],
      },
    });
    expect(out.placements.map((x) => x.tileId)).toEqual(['a2', 'a1', 'b1', 'b2']);
    expect(out.sections.find((x) => x.id === 'A')?.position).toBe(0);
    expect(out.sections.find((x) => x.id === 'B')?.position).toBe(2);
  });

  it('handles cross-section drag (item moves from A to B)', () => {
    const placements = [p('a1'), p('a2'), p('b1')];
    const sections = [s('A', 0), s('B', 2)];
    const out = rebuildPlacementsFromDndItems({
      placements,
      sections,
      displaySectionIds: ['A', 'B'],
      leadingSectionId: '__leading',
      itemsBySection: {
        A: [item('a1')], // a2 moved out
        B: [item('a2'), item('b1')], // a2 dropped here
      },
    });
    expect(out.placements.map((x) => x.tileId)).toEqual(['a1', 'a2', 'b1']);
    expect(out.sections.find((x) => x.id === 'A')?.position).toBe(0);
    expect(out.sections.find((x) => x.id === 'B')?.position).toBe(1);
  });

  it('falls back to pre-drop slice for sections missing from itemsBySection', () => {
    const placements = [p('a1'), p('b1'), p('b2')];
    const sections = [s('A', 0), s('B', 1)];
    const out = rebuildPlacementsFromDndItems({
      placements,
      sections,
      displaySectionIds: ['A', 'B'],
      leadingSectionId: '__leading',
      itemsBySection: {
        A: [item('a1')],
        // B missing — should fall back to pre-drop slice [b1, b2]
      },
    });
    expect(out.placements.map((x) => x.tileId)).toEqual(['a1', 'b1', 'b2']);
  });

  it('handles leading bucket (rows before the first section)', () => {
    const placements = [p('lead'), p('a1')];
    const sections = [s('A', 1)];
    const out = rebuildPlacementsFromDndItems({
      placements,
      sections,
      displaySectionIds: ['__leading', 'A'],
      leadingSectionId: '__leading',
      itemsBySection: {
        __leading: [item('lead')],
        A: [item('a1')],
      },
    });
    expect(out.placements.map((x) => x.tileId)).toEqual(['lead', 'a1']);
    expect(out.sections.find((x) => x.id === 'A')?.position).toBe(1);
  });

  it('drops unknown ids in items (defensive)', () => {
    const placements = [p('a1')];
    const sections = [s('A', 0)];
    const out = rebuildPlacementsFromDndItems({
      placements,
      sections,
      displaySectionIds: ['A'],
      leadingSectionId: '__leading',
      itemsBySection: {
        A: [item('a1'), item('ghost')], // 'ghost' is not in placements
      },
    });
    expect(out.placements.map((x) => x.tileId)).toEqual(['a1']);
  });

  it('preserves caller section ordering even when sorted internally by position', () => {
    // Caller passes sections in [B, A] order (alphabetically reversed).
    const placements = [p('a1'), p('b1')];
    const sections = [s('B', 1), s('A', 0)]; // intentionally reversed
    const out = rebuildPlacementsFromDndItems({
      placements,
      sections,
      displaySectionIds: ['A', 'B'],
      leadingSectionId: '__leading',
      itemsBySection: { A: [item('a1')], B: [item('b1')] },
    });
    expect(out.sections.map((x) => x.id)).toEqual(['B', 'A']);
  });

  it('renumbers all placements to 0..n-1', () => {
    const placements = [
      { tileId: 'a', position: 99 },
      { tileId: 'b', position: 200 },
    ];
    const sections = [s('A', 0)];
    const out = rebuildPlacementsFromDndItems({
      placements,
      sections,
      displaySectionIds: ['A'],
      leadingSectionId: '__leading',
      itemsBySection: { A: [{ id: 'b' }, { id: 'a' }] },
    });
    expect(out.placements.map((x) => x.position)).toEqual([0, 1]);
  });
});
