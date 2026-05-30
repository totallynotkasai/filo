/**
 * TaskListViewModel — pure-derivation pipeline that turns the active Task
 * List board's persisted placements + sections + filter UI state into the
 * row / group / section structures consumed by TaskListBoard.svelte.
 *
 * Why a class with `$derived` fields:
 *   The component used to declare 14 top-level `$derived` chains in its
 *   `<script>` block. Inlining them made the host file unmanageably long.
 *   Moving them into a class instance preserves their lazy + cached
 *   reactivity (instance `$derived` fields recompute on demand when their
 *   inputs change, exactly like top-level ones) without scattering helpers
 *   across the host. The class is declared in this `.svelte.ts` file and
 *   instantiated in the component's `<script>` so the rune compilation
 *   pipeline picks it up.
 *
 * Why the deps closure pattern:
 *   The host still owns the canonical `$state` (filter UI state, cache
 *   version tick). The view model reads them through getter closures so the
 *   class never has to import the host's stores or hold a direct reference
 *   to a `$state` variable — the closures are evaluated inside the class's
 *   own `$derived.by` callbacks, so reactivity flows through naturally.
 *
 * Why `void vaultIndexStore.version` inside `rows`:
 *   `readFrontmatter` already reads vault index data, but the version touch
 *   keeps the derivation explicitly reactive to file-watcher-driven index
 *   updates (the row data depends on frontmatter on disk).
 */

import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import {
  GROUP_ORDER,
  compareRows,
  filterTaskRows,
  groupKey,
  smartListMatch,
  type GroupBy,
  type SmartListId,
  type SortBy,
  type TaskRow,
} from '../tasks/taskListModel';
import type { Priority } from '../tasks/frontmatterReaders';
import { FIELD_READERS } from '../tasks/frontmatterReaders';
import type {
  TaskListSection,
  TaskPlacement,
  Tile,
} from '../../schema/index';

/**
 * One bucket in the grouped view. Keys are stable across renders so an
 * `{#each}` block can use them as the key.
 */
export interface TaskGroup {
  key: string;
  label: string;
  rows: TaskRow[];
}

/**
 * One bucket in the sectioned view. `id === null` is the synthetic
 * "Unsectioned" leading bucket; everything else is a persisted section
 * (potentially the synthetic default whose id is the sentinel passed via
 * `getDefaultSectionId`).
 */
export interface SectionView {
  id: string | null;
  title: string;
  collapsed: boolean;
  rows: TaskRow[];
}

export interface TaskListViewModelDeps {
  /** Placements in their canonical board-order. */
  getPlacements: () => TaskPlacement[];
  /** Map of tileId → Tile for the active board. */
  getTilesById: () => Record<string, Tile>;
  /** Sections including the virtual default — always at least one. */
  getDisplaySections: () => TaskListSection[];
  /** Bumped by the host's `tickAndPersist` after a cache mutation. */
  getCacheVersion: () => number;
  /** Reads a tile's frontmatter from the vault index. */
  readFrontmatter: (tile: Tile) => Record<string, unknown>;
  /** Active smart-list tab (drives filter + counts). */
  getActiveSmartList: () => SmartListId;
  /** Whether completed tasks are visible. */
  getShowCompleted: () => boolean;
  /** Active priority chip; `null` when off. */
  getActiveFilterPriority: () => Priority | null;
  /** Active status chip; `null` when off. */
  getActiveFilterStatus: () => string | null;
  /** Active tag chips. */
  getActiveFilterTags: () => string[];
  /** Persisted sort mode (`board.settings.sortBy`). */
  getSortBy: () => SortBy;
  /** Persisted group mode (`board.settings.groupBy`). */
  getGroupBy: () => GroupBy;
  /** Sentinel id of the virtual default section so `availableSectionsForMove` can hide it. */
  getDefaultSectionId: () => string;
}

export class TaskListViewModel {
  constructor(private deps: TaskListViewModelDeps) {}

  // ── Build the row list (filtered + sorted, then grouped) ──
  rows = $derived.by<TaskRow[]>(() => {
    void this.deps.getCacheVersion();
    void vaultIndexStore.version;

    const placements = this.deps.getPlacements();
    const tilesById = this.deps.getTilesById();
    const out: TaskRow[] = [];
    for (const placement of placements) {
      const tile = tilesById[placement.tileId];
      if (!tile) continue;
      const fm = this.deps.readFrontmatter(tile);
      out.push({
        placement,
        tile,
        completed: FIELD_READERS.completed(fm),
        priority: FIELD_READERS.priority(fm),
        dueDate: FIELD_READERS.dueDate(fm),
        dueTime: FIELD_READERS.dueTime(fm),
        startDate: FIELD_READERS.startDate(fm),
        status: FIELD_READERS.status(fm),
        tags: FIELD_READERS.tags(fm),
        parent: FIELD_READERS.parent(fm),
        recurrence: FIELD_READERS.recurrence(fm),
        recurrenceMode: FIELD_READERS.recurrenceMode(fm),
        category: FIELD_READERS.category(fm),
      });
    }
    return out;
  });

  // ── Smart-list date bucket helpers ──
  //
  // `today` is computed lazily inside the $derived so re-renders pick up the
  // current date — relevant when the app stays open across midnight.
  smartListCounts = $derived.by<Record<SmartListId, number>>(() => {
    void this.deps.getCacheVersion();
    void vaultIndexStore.version;
    const today = new SvelteDate();
    today.setHours(0, 0, 0, 0);
    const counts: Record<SmartListId, number> = {
      all: 0,
      today: 0,
      upcoming: 0,
      overdue: 0,
      'no-date': 0,
      completed: 0,
    };
    for (const r of this.rows) {
      counts.all++;
      if (r.completed) counts.completed++;
      if (smartListMatch(r, 'today', today)) counts.today++;
      if (smartListMatch(r, 'upcoming', today)) counts.upcoming++;
      if (smartListMatch(r, 'overdue', today)) counts.overdue++;
      if (smartListMatch(r, 'no-date', today)) counts['no-date']++;
    }
    return counts;
  });

  filteredRows = $derived.by<TaskRow[]>(() => {
    const today = new SvelteDate();
    today.setHours(0, 0, 0, 0);
    return filterTaskRows(this.rows, today, {
      smartList: this.deps.getActiveSmartList(),
      showCompleted: this.deps.getShowCompleted(),
      priority: this.deps.getActiveFilterPriority(),
      status: this.deps.getActiveFilterStatus(),
      tags: this.deps.getActiveFilterTags(),
    });
  });

  sortedRows = $derived.by<TaskRow[]>(() => {
    const copy = [...this.filteredRows];
    const sortBy = this.deps.getSortBy();
    copy.sort((a, b) => compareRows(a, b, sortBy));
    return copy;
  });

  // ── Subtask nesting ──
  //
  // A row whose `parent` points to another visible row is rendered nested
  // under that parent rather than as a top-level entry. A row whose parent
  // is hidden by the active filter (or whose parent has been deleted)
  // floats up — orphans are always rendered, never lost.
  //
  // Children participate in filtering and sorting on their own merit; their
  // position within the parent reflects the same `sortBy`. Grouping is
  // purely a top-level concern — children always sit under their parent
  // regardless of the parent's group.
  visibleRowIds = $derived(new SvelteSet(this.sortedRows.map((r) => r.tile.id)));

  nestedView = $derived.by<{ children: Map<string, TaskRow[]>; top: TaskRow[] }>(() => {
    const children = new SvelteMap<string, TaskRow[]>();
    const top: TaskRow[] = [];
    for (const r of this.sortedRows) {
      if (r.parent && this.visibleRowIds.has(r.parent)) {
        const list = children.get(r.parent) ?? [];
        list.push(r);
        children.set(r.parent, list);
      } else {
        top.push(r);
      }
    }
    return { children, top };
  });

  topLevelRows = $derived(this.nestedView.top);
  childrenByParent = $derived(this.nestedView.children);

  // ── Grouping ──
  //
  // groupKey / capitalize / GROUP_ORDER live in `lib/tasks/taskListModel.ts`.
  groups = $derived.by<TaskGroup[]>(() => {
    const groupBy = this.deps.getGroupBy();
    // Local midnight — mirrors `filteredRows` / `smartListCounts` so due-date
    // grouping agrees with the smart lists, and is passed explicitly to keep
    // `groupKey` deterministic rather than reading `new Date()` itself (audit 1.3).
    const today = new SvelteDate();
    today.setHours(0, 0, 0, 0);
    const buckets = new SvelteMap<string, TaskGroup>();
    for (const row of this.topLevelRows) {
      const { key, label } = groupKey(row, groupBy, today);
      let g = buckets.get(key);
      if (!g) {
        g = { key, label, rows: [] };
        buckets.set(key, g);
      }
      g.rows.push(row);
    }

    const ordered: TaskGroup[] = [];
    const known = GROUP_ORDER[groupBy] ?? [];
    for (const k of known) {
      const g = buckets.get(k);
      if (g) {
        ordered.push(g);
        buckets.delete(k);
      }
    }
    for (const g of buckets.values()) ordered.push(g);
    return ordered;
  });

  // ── Sectioned view ──
  //
  // When sections are active, each section owns the slice of the flat
  // `tasks` list between its `position` and the next section's `position`.
  // Tasks whose placement index sits before the first section's position
  // fall into an unlabelled "leading" bucket so an old (pre-section) board
  // doesn't silently drop tasks once the first section is added.
  //
  // Sort modes other than 'manual' do NOT honour `position`, so we still
  // surface the leading bucket and the section's slice using the sorted
  // top-level rows but in their *placement* order — anything else would
  // make moving a task between sections meaningless.
  sectionedView = $derived.by<SectionView[]>(() => {
    const placements = this.deps.getPlacements();
    const displaySections = this.deps.getDisplaySections();
    const topLevelRows = this.topLevelRows;

    // Map placement index → top-level row (children render under their
    // parent via childrenByParent, so iterating top-level rows here keeps
    // the top-level/child split intact).
    const indexByTileId = new SvelteMap<string, number>();
    placements.forEach((p, i) => indexByTileId.set(p.tileId, i));
    const sorted = [...displaySections].sort((a, b) => a.position - b.position);
    const result: SectionView[] = [];

    const leadingEnd = sorted[0]?.position ?? placements.length;
    const leading = topLevelRows.filter((r) => {
      const idx = indexByTileId.get(r.tile.id);
      return idx !== undefined && idx < leadingEnd;
    });
    if (leading.length > 0) {
      result.push({ id: null, title: 'Unsectioned', collapsed: false, rows: leading });
    }

    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const start = s.position;
      const end = sorted[i + 1]?.position ?? placements.length;
      const rows = topLevelRows.filter((r) => {
        const idx = indexByTileId.get(r.tile.id);
        return idx !== undefined && idx >= start && idx < end;
      });
      result.push({ id: s.id, title: s.title, collapsed: s.collapsed, rows });
    }
    return result;
  });

  /**
   * Flat list of real sections in display order — feeds the "Move to
   * section…" context menu on each TaskItem. Excludes the leading
   * "Unsectioned" bucket (null id) and the synthetic default since neither
   * is a persisted move destination.
   */
  availableSectionsForMove = $derived.by<Array<{ id: string; title: string }>>(() => {
    const defaultId = this.deps.getDefaultSectionId();
    return this.sectionedView
      .filter((s): s is SectionView & { id: string } => !!s.id && s.id !== defaultId)
      .map((s) => ({ id: s.id, title: s.title }));
  });
}
