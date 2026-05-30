import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  smartListMatch,
  compareRows,
  groupKey,
  isDeferred,
  capitalize,
  GROUP_ORDER,
  PRIORITY_ORDER,
  type TaskRow,
  type GroupBy,
  type SmartListId,
  type SortBy,
} from '@renderer/lib/tasks/taskListModel';
import type { Tile, TaskPlacement } from '@renderer/schema/index';

/**
 * Helper: produce a TaskRow with sane defaults. Tests override only the
 * fields they care about, mirroring how the renderer projects rows.
 */
function makeRow(overrides: Partial<TaskRow> = {}): TaskRow {
  const tile = {
    id: overrides.tile?.id ?? 'tile_a',
    type: 'text',
    title: overrides.tile?.title ?? 'Task',
    position: { x: 0, y: 0 },
    size: { w: 100, h: 100 },
    style: {},
    locked: false,
    createdAt: overrides.tile?.createdAt ?? 0,
  } as unknown as Tile;
  const placement: TaskPlacement = {
    tileId: tile.id,
    position: overrides.placement?.position ?? 0,
  };
  return {
    placement,
    tile,
    completed: false,
    priority: 'none',
    dueDate: '',
    dueTime: '',
    startDate: '',
    status: '',
    tags: [],
    parent: '',
    recurrence: '',
    recurrenceMode: 'schedule',
    category: '',
    ...overrides,
    tile: { ...tile, ...(overrides.tile ?? {}) },
    placement: { ...placement, ...(overrides.placement ?? {}) },
  };
}

const TODAY = new Date(2026, 4, 16); // 2026-05-16
TODAY.setHours(0, 0, 0, 0);

describe('isDeferred', () => {
  it('returns false when no startDate is set', () => {
    expect(isDeferred(makeRow(), TODAY)).toBe(false);
  });

  it('returns true when startDate is strictly in the future', () => {
    expect(isDeferred(makeRow({ startDate: '2026-05-20' }), TODAY)).toBe(true);
  });

  it('returns false when startDate equals today', () => {
    expect(isDeferred(makeRow({ startDate: '2026-05-16' }), TODAY)).toBe(false);
  });

  it('returns false when startDate is in the past', () => {
    expect(isDeferred(makeRow({ startDate: '2026-05-10' }), TODAY)).toBe(false);
  });

  it('returns false on malformed startDate', () => {
    expect(isDeferred(makeRow({ startDate: 'not-a-date' }), TODAY)).toBe(false);
  });
});

describe('capitalize', () => {
  it('uppercases the first letter', () => {
    expect(capitalize('hello')).toBe('Hello');
  });

  it('returns empty string for empty input', () => {
    expect(capitalize('')).toBe('');
  });

  it('leaves single-letter strings idempotent', () => {
    expect(capitalize('A')).toBe('A');
  });
});

describe('smartListMatch — all 5 buckets + all + completed', () => {
  it('"all" matches every row regardless of state', () => {
    expect(smartListMatch(makeRow(), 'all', TODAY)).toBe(true);
    expect(smartListMatch(makeRow({ completed: true }), 'all', TODAY)).toBe(true);
    expect(smartListMatch(makeRow({ dueDate: '2026-06-01' }), 'all', TODAY)).toBe(true);
  });

  it('"completed" matches only completed rows', () => {
    expect(smartListMatch(makeRow({ completed: true }), 'completed', TODAY)).toBe(true);
    expect(smartListMatch(makeRow(), 'completed', TODAY)).toBe(false);
  });

  it('"today" matches rows due today and not completed', () => {
    expect(smartListMatch(makeRow({ dueDate: '2026-05-16' }), 'today', TODAY)).toBe(true);
    expect(
      smartListMatch(makeRow({ dueDate: '2026-05-16', completed: true }), 'today', TODAY),
    ).toBe(false);
    expect(smartListMatch(makeRow({ dueDate: '2026-05-17' }), 'today', TODAY)).toBe(false);
  });

  it('"today" excludes deferred rows even if due today', () => {
    expect(
      smartListMatch(
        makeRow({ dueDate: '2026-05-16', startDate: '2026-05-20' }),
        'today',
        TODAY,
      ),
    ).toBe(false);
  });

  it('"upcoming" matches strictly future rows', () => {
    expect(smartListMatch(makeRow({ dueDate: '2026-05-17' }), 'upcoming', TODAY)).toBe(true);
    expect(smartListMatch(makeRow({ dueDate: '2026-05-16' }), 'upcoming', TODAY)).toBe(false);
    expect(smartListMatch(makeRow({ dueDate: '2026-05-15' }), 'upcoming', TODAY)).toBe(false);
  });

  it('"upcoming" excludes completed and deferred', () => {
    expect(
      smartListMatch(makeRow({ dueDate: '2026-06-01', completed: true }), 'upcoming', TODAY),
    ).toBe(false);
    expect(
      smartListMatch(
        makeRow({ dueDate: '2026-06-01', startDate: '2026-07-01' }),
        'upcoming',
        TODAY,
      ),
    ).toBe(false);
  });

  it('"overdue" matches past due-date rows that are not completed', () => {
    expect(smartListMatch(makeRow({ dueDate: '2026-05-15' }), 'overdue', TODAY)).toBe(true);
    expect(
      smartListMatch(makeRow({ dueDate: '2026-05-15', completed: true }), 'overdue', TODAY),
    ).toBe(false);
    expect(smartListMatch(makeRow({ dueDate: '2026-05-16' }), 'overdue', TODAY)).toBe(false);
  });

  it('"no-date" matches rows without a dueDate, excluding deferred', () => {
    expect(smartListMatch(makeRow(), 'no-date', TODAY)).toBe(true);
    expect(smartListMatch(makeRow({ dueDate: '2026-05-20' }), 'no-date', TODAY)).toBe(false);
    expect(
      smartListMatch(makeRow({ startDate: '2026-06-01' }), 'no-date', TODAY),
    ).toBe(false);
  });

  it('treats malformed dueDate as non-match for date-based buckets', () => {
    const row = makeRow({ dueDate: 'not-a-date' });
    expect(smartListMatch(row, 'today', TODAY)).toBe(false);
    expect(smartListMatch(row, 'upcoming', TODAY)).toBe(false);
    expect(smartListMatch(row, 'overdue', TODAY)).toBe(false);
  });
});

describe('compareRows — all sortBys', () => {
  const sortBy: SortBy[] = ['title', 'created', 'dueDate', 'priority', 'manual'];

  it('sortBy "title" compares case-insensitively via localeCompare', () => {
    const a = makeRow({ tile: { id: 'a', title: 'apple' } as Tile });
    const b = makeRow({ tile: { id: 'b', title: 'Banana' } as Tile });
    expect(compareRows(a, b, 'title')).toBeLessThan(0);
  });

  it('sortBy "created" compares ascending createdAt', () => {
    const older = makeRow({ tile: { id: 'a', title: 'A', createdAt: 100 } as Tile });
    const newer = makeRow({ tile: { id: 'b', title: 'B', createdAt: 200 } as Tile });
    expect(compareRows(older, newer, 'created')).toBeLessThan(0);
    expect(compareRows(newer, older, 'created')).toBeGreaterThan(0);
  });

  it('sortBy "dueDate" — rows without a date sort last', () => {
    const dated = makeRow({ dueDate: '2026-05-20' });
    const undated = makeRow();
    expect(compareRows(dated, undated, 'dueDate')).toBeLessThan(0);
    expect(compareRows(undated, dated, 'dueDate')).toBeGreaterThan(0);
    expect(compareRows(undated, undated, 'dueDate')).toBe(0);
  });

  it('sortBy "dueDate" — same date tiebreaks by time, rows without time sort after', () => {
    const earlyTime = makeRow({ dueDate: '2026-05-20', dueTime: '09:00' });
    const lateTime = makeRow({ dueDate: '2026-05-20', dueTime: '17:00' });
    const noTime = makeRow({ dueDate: '2026-05-20' });
    expect(compareRows(earlyTime, lateTime, 'dueDate')).toBeLessThan(0);
    expect(compareRows(earlyTime, noTime, 'dueDate')).toBeLessThan(0);
    expect(compareRows(noTime, earlyTime, 'dueDate')).toBeGreaterThan(0);
  });

  it('sortBy "priority" — urgent < high < medium < low < none', () => {
    const urgent = makeRow({ priority: 'urgent' });
    const high = makeRow({ priority: 'high' });
    const none = makeRow({ priority: 'none' });
    expect(compareRows(urgent, high, 'priority')).toBeLessThan(0);
    expect(compareRows(high, none, 'priority')).toBeLessThan(0);
    expect(compareRows(urgent, none, 'priority')).toBeLessThan(0);
  });

  it('sortBy "manual" falls back to placement.position', () => {
    const first = makeRow({ placement: { tileId: 'a', position: 0 } });
    const second = makeRow({ placement: { tileId: 'b', position: 1 } });
    expect(compareRows(first, second, 'manual')).toBe(-1);
    expect(compareRows(second, first, 'manual')).toBe(1);
  });

  it('exposes all 5 sortBy variants', () => {
    expect(sortBy).toHaveLength(5);
  });
});

describe('groupKey — all 6 groupBys including category', () => {
  it('groupBy "status" — completed rows go to "done"', () => {
    expect(groupKey(makeRow({ completed: true }), 'status', TODAY)).toEqual({
      key: 'done',
      label: 'Done',
    });
  });

  it('groupBy "status" — empty status → "todo"', () => {
    expect(groupKey(makeRow(), 'status', TODAY)).toEqual({ key: 'todo', label: 'To Do' });
  });

  it('groupBy "status" — "in-progress" / "in_progress" / "doing" normalise to in-progress', () => {
    expect(groupKey(makeRow({ status: 'in-progress' }), 'status', TODAY).key).toBe('in-progress');
    expect(groupKey(makeRow({ status: 'in_progress' }), 'status', TODAY).key).toBe('in-progress');
    expect(groupKey(makeRow({ status: 'doing' }), 'status', TODAY).key).toBe('in-progress');
  });

  it('groupBy "status" — custom status preserves its raw key, capitalised label', () => {
    expect(groupKey(makeRow({ status: 'blocked' }), 'status', TODAY)).toEqual({
      key: 'blocked',
      label: 'Blocked',
    });
  });

  it('groupBy "priority" — uses raw priority key, "No Priority" label for none', () => {
    expect(groupKey(makeRow({ priority: 'urgent' }), 'priority', TODAY)).toEqual({
      key: 'urgent',
      label: 'Urgent',
    });
    expect(groupKey(makeRow({ priority: 'none' }), 'priority', TODAY)).toEqual({
      key: 'none',
      label: 'No Priority',
    });
  });

  it('groupBy "dueDate" — empty dueDate → "no-date"', () => {
    expect(groupKey(makeRow(), 'dueDate', TODAY).key).toBe('no-date');
  });

  // groupKey now takes an injected `today` (audit 1.3), so these are
  // deterministic against the fixed TODAY (2026-05-16) rather than the clock.
  it('groupBy "dueDate" — past date → "overdue"', () => {
    expect(groupKey(makeRow({ dueDate: '2026-05-10' }), 'dueDate', TODAY).key).toBe('overdue');
  });

  it('groupBy "dueDate" — due today → "today"', () => {
    expect(groupKey(makeRow({ dueDate: '2026-05-16' }), 'dueDate', TODAY).key).toBe('today');
  });

  it('groupBy "dueDate" — within the week → "this-week"', () => {
    expect(groupKey(makeRow({ dueDate: '2026-05-20' }), 'dueDate', TODAY).key).toBe('this-week');
  });

  it('groupBy "dueDate" — far-future date → "later"', () => {
    expect(groupKey(makeRow({ dueDate: '2026-09-01' }), 'dueDate', TODAY).key).toBe('later');
  });

  it('groupBy "tag" — empty tags → "untagged"; non-empty → first tag', () => {
    expect(groupKey(makeRow(), 'tag', TODAY)).toEqual({ key: 'untagged', label: 'Untagged' });
    expect(groupKey(makeRow({ tags: ['work', 'errand'] }), 'tag', TODAY)).toEqual({
      key: 'tag:work',
      label: '#work',
    });
  });

  it('groupBy "category" — empty/whitespace → "uncategorised"; non-empty → lowercased key + original label', () => {
    expect(groupKey(makeRow(), 'category', TODAY)).toEqual({
      key: 'uncategorised',
      label: 'Uncategorised',
    });
    expect(groupKey(makeRow({ category: '   ' }), 'category', TODAY)).toEqual({
      key: 'uncategorised',
      label: 'Uncategorised',
    });
    expect(groupKey(makeRow({ category: 'Home' }), 'category', TODAY)).toEqual({
      key: 'category:home',
      label: 'Home',
    });
    expect(groupKey(makeRow({ category: 'Work Stuff' }), 'category', TODAY)).toEqual({
      key: 'category:work stuff',
      label: 'Work Stuff',
    });
  });

  it('groupBy "none" — always returns a single bucket', () => {
    expect(groupKey(makeRow(), 'none', TODAY)).toEqual({ key: 'all', label: 'All Tasks' });
    expect(groupKey(makeRow({ priority: 'urgent', tags: ['x'] }), 'none', TODAY)).toEqual({
      key: 'all',
      label: 'All Tasks',
    });
  });
});

describe('GROUP_ORDER + PRIORITY_ORDER constants', () => {
  it('GROUP_ORDER covers all 6 groupBys', () => {
    const groupBys: GroupBy[] = ['status', 'priority', 'tag', 'dueDate', 'category', 'none'];
    for (const g of groupBys) {
      expect(GROUP_ORDER[g]).toBeDefined();
    }
  });

  it('GROUP_ORDER for "status" lists todo → in-progress → done', () => {
    expect(GROUP_ORDER.status).toEqual(['todo', 'in-progress', 'done']);
  });

  it('GROUP_ORDER for "priority" lists urgent → high → medium → low → none', () => {
    expect(GROUP_ORDER.priority).toEqual(['urgent', 'high', 'medium', 'low', 'none']);
  });

  it('GROUP_ORDER for "dueDate" lists overdue → today → this-week → later → no-date', () => {
    expect(GROUP_ORDER.dueDate).toEqual(['overdue', 'today', 'this-week', 'later', 'no-date']);
  });

  it('GROUP_ORDER for dynamic buckets (tag, category) is empty (renderer fills alphabetically)', () => {
    expect(GROUP_ORDER.tag).toEqual([]);
    expect(GROUP_ORDER.category).toEqual([]);
  });

  it('GROUP_ORDER for "none" lists exactly the single all bucket', () => {
    expect(GROUP_ORDER.none).toEqual(['all']);
  });

  it('PRIORITY_ORDER weights urgent < high < medium < low < none', () => {
    expect(PRIORITY_ORDER.urgent).toBeLessThan(PRIORITY_ORDER.high);
    expect(PRIORITY_ORDER.high).toBeLessThan(PRIORITY_ORDER.medium);
    expect(PRIORITY_ORDER.medium).toBeLessThan(PRIORITY_ORDER.low);
    expect(PRIORITY_ORDER.low).toBeLessThan(PRIORITY_ORDER.none);
  });
});

describe('smartListMatch — bucket sanity', () => {
  it('exposes all 5 referenced buckets plus all + completed', () => {
    const buckets: SmartListId[] = ['all', 'today', 'upcoming', 'overdue', 'no-date', 'completed'];
    for (const b of buckets) {
      // simply assert the bucket is callable — defensive in case the union
      // ever loses a member.
      expect(() => smartListMatch(makeRow(), b, TODAY)).not.toThrow();
    }
  });
});

describe('date parsing is local-time, not UTC (audit 1.1)', () => {
  // Reproduce the off-by-one: in any UTC-negative zone `new Date('2026-05-16')`
  // is UTC midnight = the *previous* local day, so the old code filed a
  // due-today task as "overdue" and dropped it from the "today" list. Pinning
  // the runner to America/New_York makes this a true regression guard — it
  // fails on the pre-fix UTC-parsing code and passes on local construction.
  const ORIGINAL_TZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  function localMidnight(y: number, m: number, d: number): Date {
    const t = new Date(y, m - 1, d);
    t.setHours(0, 0, 0, 0);
    return t;
  }

  it('smartListMatch files a task due today under "today", never "overdue"', () => {
    const today = localMidnight(2026, 5, 16);
    const row = makeRow({ dueDate: '2026-05-16' });
    expect(smartListMatch(row, 'today', today)).toBe(true);
    expect(smartListMatch(row, 'overdue', today)).toBe(false);
    expect(smartListMatch(row, 'upcoming', today)).toBe(false);
  });

  it('groupKey files a task due today under "today", not "overdue"', () => {
    const today = localMidnight(2026, 5, 16);
    expect(groupKey(makeRow({ dueDate: '2026-05-16' }), 'dueDate', today).key).toBe('today');
  });

  it('isDeferred compares start dates in local time', () => {
    const today = localMidnight(2026, 5, 16);
    expect(isDeferred(makeRow({ startDate: '2026-05-17' }), today)).toBe(true);
    expect(isDeferred(makeRow({ startDate: '2026-05-16' }), today)).toBe(false);
  });
});
