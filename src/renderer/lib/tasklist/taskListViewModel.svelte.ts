/**
 * TaskListViewModel — pure-derivation pipeline that turns the active Task
 * List board's persisted placements + sections + filter UI state into the
 * row / group / section structures consumed by TaskListBoard.svelte.
 *
 * Why a class with `$derived` fields:
 *   Keeping the ~14 `$derived` chains out of the component's `<script>` keeps
 *   the host file manageable. A class instance preserves their lazy + cached
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
 * Reactivity of `rows`: `readFrontmatter` reads each task's note through the
 *   note selectors, which track that note alone (its model, or its vault
 *   index entry). A save of one note re-runs `rows` once; it never reads the
 *   index's vault-wide `version`, which would re-run it on every save of any
 *   note.
 */

// The row/group/section derivations below build their date,
// map, and set scratch collections INSIDE a `$derived` body (or a `$derived`
// field), use them only to produce that derivation's return value, and rebuild
// them from scratch on every recompute. Reactivity already flows through the
// enclosing `$derived`, so the Svelte-reactive variants (`SvelteDate`/`SvelteMap`/
// `SvelteSet`) add proxy overhead with no observable benefit (mirrors the
// `spatial.svelte.ts` non-reactive caches). Plain built-ins are used, each marked
// with the lint escape the project reserves for exactly this case.
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
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { noteFieldsKnown } from '../../stores/noteMeta';
import { resolveTextTileVaultPath } from '../boards/textTilePath';
import { buildTaskDepths } from './blockMove';
import { FIELD_READERS } from '../tasks/frontmatterReaders';
import { taskParent } from './taskParent';
import { clockStore } from '../../stores/clock.svelte';
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
  /** Top-level rows, group by group when a Group By is on. */
  rows: TaskRow[];
  /** The section's groups under the board's Group By (none with Group By None). */
  groups: TaskGroup[];
}

/** One row as drawn: the row, its subtask depth, and the group heading it opens. */
export interface FlatRowEntry {
  row: TaskRow;
  depth: number;
  /** Set on the first row of each group (with a Group By): the heading above it. */
  group?: { label: string; count: number };
}

/** A section's rows as drawn, in order. */
export interface FlatSection {
  /** The section's id, or the leading bucket's sentinel. */
  sectionId: string;
  collapsed: boolean;
  entries: FlatRowEntry[];
}

/**
 * Splits `rows` (in display order) into groups by `groupBy`: the known
 * groups in `GROUP_ORDER`, then the others in the order they first appear.
 */
function groupRows(rows: TaskRow[], groupBy: GroupBy, today: Date): TaskGroup[] {
  if (groupBy === 'none') return [];
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local grouping scratch; reactivity is the enclosing $derived
  const buckets = new Map<string, TaskGroup>();
  for (const row of rows) {
    const { key, label } = groupKey(row, groupBy, today);
    let g = buckets.get(key);
    if (!g) {
      g = { key, label, rows: [] };
      buckets.set(key, g);
    }
    g.rows.push(row);
  }
  const ordered: TaskGroup[] = [];
  for (const k of GROUP_ORDER[groupBy] ?? []) {
    const g = buckets.get(k);
    if (g) {
      ordered.push(g);
      buckets.delete(k);
    }
  }
  for (const g of buckets.values()) ordered.push(g);
  return ordered;
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
  /** Tasks whose subtasks are folded away (the board's `collapsedSubtasks`). */
  getCollapsedSubtasks: () => ReadonlySet<string>;
  /** The id the drawn sections give the leading "Unsectioned" bucket. */
  getLeadingSectionId: () => string;
}

/** Equal values, one level deep (arrays element by element): a row or a tile. */
function sameShallow(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => {
    const x = ra[k];
    const y = rb[k];
    if (x === y) return true;
    return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i]);
  });
}

function sameRow(a: TaskRow, b: TaskRow): boolean {
  const { tile: ta, ...fa } = a;
  const { tile: tb, ...fb } = b;
  return (ta === tb || sameShallow(ta, tb)) && sameShallow(fa, fb);
}

export class TaskListViewModel {
  constructor(private deps: TaskListViewModelDeps) {}

  /**
   * The rows of the last derivation, by tile id. A row whose values didn't
   * change keeps its object, so its view doesn't re-render when another
   * task's note is saved (or arrives while the vault is read at open).
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo of the last derivation, not reactive state
  #lastRows = new Map<string, TaskRow>();

  // ── Build the row list (filtered + sorted, then grouped) ──
  rows = $derived.by<TaskRow[]>(() => {
    void this.deps.getCacheVersion();

    const placements = this.deps.getPlacements();
    const tilesById = this.deps.getTilesById();
    // While the vault is read at open, a note not yet reached has no fields.
    const indexing = vaultIndexStore.isBuilding;
    const out: TaskRow[] = [];
    for (const placement of placements) {
      const tile = tilesById[placement.tileId];
      if (!tile) continue;
      const fm = this.deps.readFrontmatter(tile);
      const noteParent = FIELD_READERS.parent(fm);
      const path = indexing ? resolveTextTileVaultPath(tile) : null;
      const row: TaskRow = {
        fieldsPending: path ? !noteFieldsKnown(path) : false,
        placement,
        tile,
        completed: FIELD_READERS.completed(fm),
        priority: FIELD_READERS.priority(fm),
        dueDate: FIELD_READERS.dueDate(fm),
        dueTime: FIELD_READERS.dueTime(fm),
        startDate: FIELD_READERS.startDate(fm),
        status: FIELD_READERS.status(fm),
        tags: FIELD_READERS.tags(fm),
        parent: taskParent(placement, noteParent),
        noteParent,
        recurrence: FIELD_READERS.recurrence(fm),
        recurrenceMode: FIELD_READERS.recurrenceMode(fm),
        recurrenceAnchor: FIELD_READERS.recurrenceAnchor(fm),
        category: FIELD_READERS.category(fm),
      };
      const last = this.#lastRows.get(tile.id);
      out.push(last && sameRow(last, row) ? last : row);
    }
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- the memo above
    this.#lastRows = new Map(out.map((r) => [r.tile.id, r]));
    return out;
  });

  // ── Smart-list date bucket helpers ──
  //
  // `today` is the clock store's day, so the lists move on at midnight.
  smartListCounts = $derived.by<Record<SmartListId, number>>(() => {
    void this.deps.getCacheVersion();
    const today = clockStore.todayDate();
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
    const today = clockStore.todayDate();
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
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- the $derived itself is the reactive value; the Set is rebuilt each run
  visibleRowIds = $derived(new Set(this.sortedRows.map((r) => r.tile.id)));

  nestedView = $derived.by<{ children: Map<string, TaskRow[]>; top: TaskRow[] }>(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- nestedView is the reactive $derived; this Map is its rebuilt-each-run output
    const children = new Map<string, TaskRow[]>();
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
  /** Each task's depth in the subtask hierarchy (0-2), all rows in one pass. */
  taskDepths = $derived(buildTaskDepths(this.rows));

  // ── Sectioned view ──
  //
  // When sections are active, each section owns the slice of the flat
  // `tasks` list between its `position` and the next section's `position`.
  // Tasks whose placement index sits before the first section's position
  // fall into an unlabelled "leading" bucket so an old (pre-section) board
  // doesn't silently drop tasks once the first section is added.
  //
  // Two distinct orderings are at play, don't conflate them:
  //   • MEMBERSHIP (which section owns a row) is decided by the row's
  //     PLACEMENT index against the section ranges (`ownerByIndex`), NOT by the
  //     active sort — so moving a task between sections is meaningful under any
  //     sort mode.
  //   • The ORDER of rows WITHIN a section follows `topLevelRows`, i.e. the
  //     active sort — so a non-'manual' sort still sorts inside each section.
  //     With a Group By, the section's rows go group by group (`groupKey`,
  //     `GROUP_ORDER`), each group in the sort's order.
  // A drag reorder under a non-'manual' sort therefore can't reliably set a
  // task's position WITHIN a section without flipping to Manual: same-section
  // drags do exactly that, while a cross-section move keeps the sort because
  // only the membership change is persisted (see `commitReorder` in
  // TaskListBoard.svelte).
  sectionedView = $derived.by<SectionView[]>(() => {
    const placements = this.deps.getPlacements();
    const displaySections = this.deps.getDisplaySections();
    const topLevelRows = this.topLevelRows;
    const groupBy = this.deps.getGroupBy();
    // Local midnight, as the smart lists use, so due-date groups agree with them.
    const today = clockStore.todayDate();
    const grouped = (rows: TaskRow[]): { rows: TaskRow[]; groups: TaskGroup[] } => {
      const groups = groupRows(rows, groupBy, today);
      return groups.length > 0 ? { rows: groups.flatMap((g) => g.rows), groups } : { rows, groups };
    };

    // Map placement index → top-level row (children render under their
    // parent via childrenByParent, so iterating top-level rows here keeps
    // the top-level/child split intact).
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch map; reactivity is the enclosing $derived
    const indexByTileId = new Map<string, number>();
    placements.forEach((p, i) => indexByTileId.set(p.tileId, i));
    const sorted = [...displaySections].sort((a, b) => a.position - b.position);

    // Assign each top-level row to its owning section in ONE pass instead of a
    // `.filter` per section (O(sections × rows)). Sections
    // partition the placement range into contiguous `[position, nextPosition)`
    // slices, so precompute, for every placement index, the section that owns it
    // (`ownerByIndex`; −1 ⇒ the leading "Unsectioned" bucket). The slices don't
    // overlap, so filling them is O(placements) total; the row scan is then
    // O(rows). Behaviour matches a per-section filter: row order
    // within a bucket follows `topLevelRows`, every real section is emitted even
    // when empty, the leading bucket is emitted only when non-empty, and a row
    // whose tile has no placement index is dropped from every bucket.
    const ownerByIndex = new Array<number>(placements.length).fill(-1);
    for (let k = 0; k < sorted.length; k++) {
      const s = sorted[k];
      if (!s) continue; // k < sorted.length; narrow for the type-checker
      const start = Math.max(0, s.position);
      const end = Math.min(placements.length, sorted[k + 1]?.position ?? placements.length);
      for (let i = start; i < end; i++) ownerByIndex[i] = k;
    }

    const leadingRows: TaskRow[] = [];
    const sectionRows: TaskRow[][] = sorted.map(() => []);
    for (const r of topLevelRows) {
      const idx = indexByTileId.get(r.tile.id);
      if (idx === undefined) continue; // tile not in this board's placements — drop, as before
      const owner = ownerByIndex[idx];
      if (owner === undefined || owner < 0) {
        leadingRows.push(r);
      } else {
        const bucket = sectionRows[owner];
        if (bucket) bucket.push(r);
      }
    }

    const result: SectionView[] = [];
    if (leadingRows.length > 0) {
      result.push({ id: null, title: 'Unsectioned', collapsed: false, ...grouped(leadingRows) });
    }
    for (let k = 0; k < sorted.length; k++) {
      const s = sorted[k];
      if (!s) continue; // k < sorted.length; narrow for the type-checker
      result.push({ id: s.id, title: s.title, collapsed: s.collapsed, ...grouped(sectionRows[k] ?? []) });
    }
    return result;
  });

  /**
   * Each section's rows as drawn: every top-level row followed by its shown
   * subtasks (a folded parent's are left out), each group's first row
   * carrying its heading. The row dndzones are built from this, one entry
   * per drawn row.
   */
  flatSections = $derived.by<FlatSection[]>(() => {
    const collapsed = this.deps.getCollapsedSubtasks();
    const children = this.childrenByParent;
    const leadingId = this.deps.getLeadingSectionId();
    return this.sectionedView.map((s) => {
      const entries: FlatRowEntry[] = [];
      const walk = (row: TaskRow, depth: number): void => {
        entries.push({ row, depth });
        if (collapsed.has(row.tile.id)) return;
        for (const kid of children.get(row.tile.id) ?? []) walk(kid, depth + 1);
      };
      for (const g of s.groups.length > 0 ? s.groups : [{ key: '', label: '', rows: s.rows }]) {
        const first = entries.length;
        for (const row of g.rows) walk(row, 0);
        const head = entries[first];
        if (head && g.key) head.group = { label: g.label, count: g.rows.length };
      }
      return { sectionId: s.id ?? leadingId, collapsed: s.collapsed, entries };
    });
  });

  /**
   * The rows on screen, top to bottom: sections in order, a folded section's
   * rows and a folded parent's subtasks left out. The arrow keys, Tab,
   * Shift-click ranges and Select All follow this order, so a key or a range
   * never reaches a row the user can't see or skips one they can.
   */
  renderedRows = $derived.by<TaskRow[]>(() =>
    this.flatSections.filter((s) => !s.collapsed).flatMap((s) => s.entries.map((e) => e.row)),
  );

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
