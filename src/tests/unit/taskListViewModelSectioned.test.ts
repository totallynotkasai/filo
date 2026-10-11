import { describe, it, expect } from 'vitest';
import {
  TaskListViewModel,
  type TaskListViewModelDeps,
} from '@renderer/lib/tasklist/taskListViewModel.svelte';
import type { Tile, TaskPlacement, TaskListSection } from '@renderer/schema/index';
import type { SortBy } from '@renderer/lib/tasks/taskListModel';

/**
 * `sectionedView` was rewritten from a `.filter` per section
 * (O(sections × rows)) to a single-pass bucket assignment. These tests lock in
 * the behaviour the rewrite must preserve: the leading "Unsectioned" bucket is
 * emitted only when non-empty, each section owns the contiguous
 * `[position, nextPosition)` placement-index slice, EVERY real section is
 * emitted (even when empty), and row order within a bucket follows the (sorted)
 * top-level rows — not placement order.
 */

function tile(id: string, title = id): Tile {
  return {
    id,
    type: 'text',
    title,
    position: { x: 0, y: 0 },
    size: { w: 1, h: 1 },
    style: {},
    locked: false,
    createdAt: 0,
  } as unknown as Tile;
}

function makeVm(opts: {
  placements: TaskPlacement[];
  sections: TaskListSection[];
  sortBy?: SortBy;
  titles?: Record<string, string>;
}): TaskListViewModel {
  const tilesById: Record<string, Tile> = {};
  for (const p of opts.placements) {
    tilesById[p.tileId] = tile(p.tileId, opts.titles?.[p.tileId] ?? p.tileId);
  }
  const deps: TaskListViewModelDeps = {
    getPlacements: () => opts.placements,
    getTilesById: () => tilesById,
    getDisplaySections: () => opts.sections,
    getCacheVersion: () => 0,
    readFrontmatter: () => ({}),
    getActiveSmartList: () => 'all',
    getShowCompleted: () => true,
    getActiveFilterPriority: () => null,
    getActiveFilterStatus: () => null,
    getActiveFilterTags: () => [],
    getSortBy: () => opts.sortBy ?? 'manual',
    getGroupBy: () => 'none',
    getDefaultSectionId: () => 'default',
    getCollapsedSubtasks: () => new Set(),
    getLeadingSectionId: () => '__leading__',
  };
  return new TaskListViewModel(deps);
}

const place = (...ids: string[]): TaskPlacement[] =>
  ids.map((tileId, i) => ({ tileId, position: i }));

const section = (
  id: string,
  position: number,
  collapsed = false,
): TaskListSection => ({ id, title: id.toUpperCase(), position, collapsed });

/** Project the view to `[bucketId, [tileIds...]]` pairs for compact assertions. */
function shape(vm: TaskListViewModel): Array<[string | null, string[]]> {
  return vm.sectionedView.map((s) => [s.id, s.rows.map((r) => r.tile.id)]);
}

describe('TaskListViewModel.sectionedView — single-pass bucketing', () => {
  it('splits a leading bucket plus two sections by placement index', () => {
    const vm = makeVm({
      placements: place('t1', 't2', 't3', 't4'),
      sections: [section('s1', 1), section('s2', 3)],
    });
    expect(shape(vm)).toEqual([
      [null, ['t1']], // idx 0 < first section position (1)
      ['s1', ['t2', 't3']], // [1, 3)
      ['s2', ['t4']], // [3, end)
    ]);
  });

  it('omits the leading bucket when the first section starts at position 0', () => {
    const vm = makeVm({
      placements: place('t1', 't2', 't3'),
      sections: [section('d', 0)],
    });
    expect(shape(vm)).toEqual([['d', ['t1', 't2', 't3']]]);
  });

  it('still emits a section that owns no rows', () => {
    // s2 starts at position 5 but there are only 2 placements → its slice is empty.
    const vm = makeVm({
      placements: place('t1', 't2'),
      sections: [section('s1', 0), section('s2', 5)],
    });
    expect(shape(vm)).toEqual([
      ['s1', ['t1', 't2']],
      ['s2', []],
    ]);
  });

  it('renders a mid-list empty section tied with the next (cross-section move end state)', () => {
    // The post-move state of the section-drag bug: 3 sections, one task each,
    // the middle one emptied so its position ties the next's. sectionedView
    // disambiguates the tie by array order — the earlier section (s2) owns the
    // empty [2,2) slice, the later (s3) owns [2,3). This is the render-side proof
    // that pairs with the persist test keeping the positions tied: the dragged
    // task lands in s1 and s3's task stays put.
    const vm = makeVm({
      placements: place('t1', 't2', 't3'),
      sections: [section('s1', 0), section('s2', 2), section('s3', 2)],
    });
    expect(shape(vm)).toEqual([
      ['s1', ['t1', 't2']], // [0, 2)
      ['s2', []], // [2, 2) — empty, NOT stealing t3
      ['s3', ['t3']], // [2, 3)
    ]);
  });

  it('array order is load-bearing — a section listed BEFORE an empty tie loses its slice', () => {
    // Tied-section ownership is decided by ARRAY ORDER: the section listed LAST
    // at a shared position owns the slice, earlier ones render empty. So if a
    // section that "wants" the tasks is listed BEFORE an empty section at the
    // same position, the later (empty-intended) section steals them. This is the
    // hazard the persist layer guards against by keeping empties listed
    // first (see boardCacheTaskList.persistTaskListStructure). The view model
    // faithfully applies the rule either way.
    const vm = makeVm({
      placements: place('t1', 't2', 't3'),
      sections: [section('s1', 0), section('wantsTasks', 2), section('wantsEmpty', 2)],
    });
    expect(shape(vm)).toEqual([
      ['s1', ['t1', 't2']], // [0, 2)
      ['wantsTasks', []], // tied + listed first ⇒ empty
      ['wantsEmpty', ['t3']], // tied + listed last ⇒ owns [2, 3)
    ]);
  });

  it('orders rows within a bucket by the sorted top-level rows, not placement order', () => {
    // Placement order is t3, t1, t2 (indices 0,1,2) but a title sort renders
    // them t1, t2, t3 — the single section owns the whole [0, end) slice, so the
    // bucket must reflect the SORTED order, mirroring the old per-section filter.
    const vm = makeVm({
      placements: place('t3', 't1', 't2'),
      sections: [section('only', 0)],
      sortBy: 'title',
      titles: { t1: 'Apple', t2: 'Banana', t3: 'Cherry' },
    });
    expect(shape(vm)).toEqual([['only', ['t1', 't2', 't3']]]);
  });

  it('sorts unsorted section input by position before slicing', () => {
    // Sections supplied out of order must be normalised by position; the leading
    // bucket boundary is the LOWEST position, not the array-first section.
    const vm = makeVm({
      placements: place('t1', 't2', 't3', 't4'),
      sections: [section('late', 2), section('early', 1)],
    });
    expect(shape(vm)).toEqual([
      [null, ['t1']], // idx 0 < lowest position (1)
      ['early', ['t2']], // [1, 2)
      ['late', ['t3', 't4']], // [2, end)
    ]);
  });
});
