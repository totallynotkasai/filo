/**
 * Task List transient view state — filters + smart-list + saved views +
 * lastView persistence (Sprint 39 / 39.8).
 *
 * Pulled out of `TaskListBoard.svelte` so the component focuses on the
 * structural / rendering wiring. The class follows the same pattern as
 * `MultiSelectController` and `TaskListViewModel` — `$state` fields are
 * rune-tracked from inside a `.svelte.ts` module, instantiated by the host
 * component, and consumed via getters / setter methods.
 *
 * Effects (lastView hydrate / debounced persist) live in the host because
 * Svelte's `$effect` registration must happen in component context so the
 * teardown participates in the component lifecycle. The host calls
 * `hydrateFromLastView(board.id, lastViewSlice)` once per board and the
 * debounced `lastView` write fires from a host-side `$effect`.
 */

import { createId } from '../utils/ids';
import { historyStore } from '../../stores/history.svelte';
import { UpdateSavedViewsCommand } from '../../commands/index';
import type { Priority } from '../tasks/frontmatterReaders';
import type { GroupBy, SortBy, SmartListId } from '../tasks/taskListModel';

/**
 * A persisted view bundle — every dimension the user can adjust via the
 * Task List side toolbar / smart list tabs. Saved under
 * `board.settings.savedViews`; restored via `applySavedView()`.
 */
export interface SavedView {
  id: string;
  name: string;
  groupBy: GroupBy;
  sortBy: SortBy;
  filterTags: string[];
  filterStatus: string | null;
  filterPriority: Priority | null;
  showCompleted: boolean;
  smartList: SmartListId;
}

/**
 * Shape of the `lastView` slice persisted under `board.settings.lastView`.
 * Read by the host's hydrate effect; each field is permissive because the
 * value lives in a hand-editable .board.json.
 */
export interface LastViewSlice {
  groupBy?: GroupBy;
  sortBy?: SortBy;
  filterTags?: string[];
  filterStatus?: string | null;
  filterPriority?: Priority | null;
  showCompleted?: boolean;
  smartList?: SmartListId;
}

interface FiltersAndViewsDeps {
  /** Read the current `board.settings.savedViews` array. */
  getSavedViewsRaw: () => unknown;
  /** Apply a partial settings patch (groupBy/sortBy on view apply). */
  updateSettings: (patch: Record<string, unknown>) => void;
  /** Persist a replacement saved-views array via boardCacheStore. */
  setSavedViews: (next: SavedView[]) => void;
  /** Bumps cacheVersion so derived UI re-evaluates. */
  tickAndPersist: () => void;
  /** Read current groupBy (board setting) — captured at save time. */
  getGroupBy: () => GroupBy;
  /** Read current sortBy (board setting) — captured at save time. */
  getSortBy: () => SortBy;
  /** Push a screen-reader announcement (used by clearAllFilters). */
  announce: (message: string) => void;
  /**
   * Phase 7 / 7.5 — board id used as the history `targetBoardId` so the
   * undo dispatcher won't replay a saved-views change against a different
   * board. Optional for back-compat with callers that don't supply it yet
   * (the command falls through to the bare cache write without history).
   */
  getBoardId?: () => string | null;
}

export class TaskListFiltersAndViews {
  /** Transient filter dimensions — non-persistent across board switches. */
  activeFilterTags = $state<string[]>([]);
  activeFilterStatus = $state<string | null>(null);
  activeFilterPriority = $state<Priority | null>(null);
  showCompleted = $state(true);
  activeSmartList = $state<SmartListId>('all');

  /** True when any filter dimension is narrowing the rendered set. */
  hasActiveFilter = $derived(
    this.activeFilterTags.length > 0
      || this.activeFilterStatus !== null
      || this.activeFilterPriority !== null
      || !this.showCompleted
      || this.activeSmartList !== 'all',
  );

  /**
   * Per-board "I've already hydrated lastView for this board" gate. Used by
   * the host's hydrate effect to skip re-hydration on every render and only
   * re-fire when the board.id changes.
   */
  hydratedForBoardId = $state<string | null>(null);

  /** Debounce handle for the persistence write — owned by the host. */
  lastViewPersistTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Audit2 5.6 — clears the pending lastView debounce so a host unmount
   * mid-window doesn't fire `updateSettings` + push a history entry against
   * a board that's already torn down. Called from `TaskListBoard.svelte`'s
   * `onDestroy`. Idempotent — safe to call when no timer is armed.
   */
  dispose(): void {
    if (this.lastViewPersistTimer) {
      clearTimeout(this.lastViewPersistTimer);
      this.lastViewPersistTimer = null;
    }
  }

  /**
   * Parsed view of `board.settings.savedViews`. Defensively filters out
   * malformed entries so a hand-edited .board.json with a junk view doesn't
   * crash the toolbar.
   */
  savedViews = $derived.by<SavedView[]>(() => {
    const raw = this.deps.getSavedViewsRaw();
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is SavedView => {
      if (!v || typeof v !== 'object') return false;
      const obj = v as Record<string, unknown>;
      return typeof obj.id === 'string' && typeof obj.name === 'string';
    });
  });

  constructor(private deps: FiltersAndViewsDeps) {}

  // ── Filter setters ──────────────────────────────────────────────────────

  applyFilterTags(tags: string[]): void {
    this.activeFilterTags = tags;
  }

  applyFilterStatus(s: string | null): void {
    this.activeFilterStatus = s;
  }

  applyFilterPriority(p: Priority | null): void {
    this.activeFilterPriority = p;
  }

  setShowCompleted(v: boolean): void {
    this.showCompleted = v;
  }

  /**
   * Resets every transient filter dimension back to the broad "All" view.
   * Used by the filter-aware empty state's "Clear filters" CTA so a single
   * click rescues the user from a filter combination that hides everything.
   */
  clearAllFilters(): void {
    this.activeFilterTags = [];
    this.activeFilterStatus = null;
    this.activeFilterPriority = null;
    this.showCompleted = true;
    this.activeSmartList = 'all';
    this.deps.announce('Filters cleared');
  }

  // ── lastView hydration / persistence ────────────────────────────────────

  /**
   * Restores transient filter state from the persisted `lastView` slice.
   * Called by the host once per board change (gated by hydratedForBoardId).
   * `null` / missing input resets to the default "all" view.
   */
  hydrateFromLastView(boardId: string, lv: LastViewSlice | null): void {
    if (lv && typeof lv === 'object') {
      this.activeFilterTags = Array.isArray(lv.filterTags) ? [...lv.filterTags] : [];
      this.activeFilterStatus = lv.filterStatus ?? null;
      this.activeFilterPriority = lv.filterPriority ?? null;
      this.showCompleted = lv.showCompleted ?? true;
      this.activeSmartList = lv.smartList ?? 'all';
    } else {
      this.activeFilterTags = [];
      this.activeFilterStatus = null;
      this.activeFilterPriority = null;
      this.showCompleted = true;
      this.activeSmartList = 'all';
    }
    this.hydratedForBoardId = boardId;
  }

  /**
   * Captures the *next* `lastView` slice that should be persisted given the
   * current transient state. The host wraps this in a 300ms debounce so
   * rapid filter changes coalesce into one .board.json write.
   */
  buildLastView(): LastViewSlice {
    return {
      groupBy: this.deps.getGroupBy(),
      sortBy: this.deps.getSortBy(),
      filterTags: [...this.activeFilterTags],
      filterStatus: this.activeFilterStatus,
      filterPriority: this.activeFilterPriority,
      showCompleted: this.showCompleted,
      smartList: this.activeSmartList,
    };
  }

  // ── Saved views CRUD ────────────────────────────────────────────────────

  /**
   * Restores a saved view: transient filter state from the view's slice,
   * plus a settings patch for groupBy / sortBy (which live in board
   * settings rather than transient state).
   */
  applySavedView(view: SavedView): void {
    this.activeFilterTags = [...view.filterTags];
    this.activeFilterStatus = view.filterStatus;
    this.activeFilterPriority = view.filterPriority;
    this.showCompleted = view.showCompleted;
    this.activeSmartList = view.smartList;
    this.deps.updateSettings({ groupBy: view.groupBy, sortBy: view.sortBy });
  }

  /**
   * Saves the current view as a named bundle. Replaces an existing view
   * with the same (case-insensitive) name so users can iterate without
   * stacking near-duplicates.
   */
  saveCurrentView(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const before = [...this.savedViews];
    const existing = this.savedViews.filter(
      (v) => v.name.toLowerCase() !== trimmed.toLowerCase(),
    );
    const view: SavedView = {
      id: createId(),
      name: trimmed,
      groupBy: this.deps.getGroupBy(),
      sortBy: this.deps.getSortBy(),
      filterTags: [...this.activeFilterTags],
      filterStatus: this.activeFilterStatus,
      filterPriority: this.activeFilterPriority,
      showCompleted: this.showCompleted,
      smartList: this.activeSmartList,
    };
    const after = [...existing, view];
    // Phase 7 / 7.5 — route through history so Ctrl+Z reverses save / delete.
    const boardId = this.deps.getBoardId?.() ?? null;
    if (boardId) {
      historyStore.execute(
        new UpdateSavedViewsCommand(boardId, 'tasklist', before, after, `Save view "${trimmed}"`),
      );
    } else {
      this.deps.setSavedViews(after);
    }
    this.deps.tickAndPersist();
  }

  /** Removes a saved view by id. */
  deleteSavedView(id: string): void {
    const before = [...this.savedViews];
    const next = this.savedViews.filter((v) => v.id !== id);
    if (next.length === before.length) return;
    const removed = before.find((v) => v.id === id);
    const boardId = this.deps.getBoardId?.() ?? null;
    if (boardId) {
      historyStore.execute(
        new UpdateSavedViewsCommand(
          boardId,
          'tasklist',
          before,
          next,
          removed ? `Delete view "${removed.name}"` : 'Delete view',
        ),
      );
    } else {
      this.deps.setSavedViews(next);
    }
    this.deps.tickAndPersist();
  }
}
