import { historyStore } from '../../stores/history.svelte';
import { UpdateSavedViewsCommand } from '../../commands/index';
import { createId } from '../utils/ids';
import type { KanbanFilterProp, KanbanLastView, KanbanSortBy } from './kanbanFiltersAndSort.svelte';

export interface SavedKanbanView {
  id: string;
  name: string;
  sortBy: KanbanSortBy;
  filterTags: string[];
  filterProp: KanbanFilterProp | null;
}

export interface KanbanSavedViewsDeps {
  getBoardId: () => string | null;
  /** Live read of the active board's settings; `savedViews` is parsed off of this. */
  getSettings: () => Record<string, unknown>;
  /** Live snapshot of the active filter/sort triplet — used by `saveCurrentView`. */
  getCurrentSnapshot: () => KanbanLastView;
  /** Pushes a view into the filter/sort controller. */
  applyToFilters: (view: SavedKanbanView) => void;
  tickAndPersist: () => void;
}

/**
 * Saved-views controller for the Kanban board.
 *
 * Persists named filter/sort triplets onto `settings.savedViews` via
 * `boardCacheStore.setKanbanSavedViews`. Same-name saves replace the
 * existing entry (case-insensitive) so re-saving by name acts as an
 * "update" rather than stacking duplicates.
 */
export class KanbanSavedViews {
  savedViews = $derived.by<SavedKanbanView[]>(() => {
    const raw = (this.deps.getSettings().savedViews ?? []) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is SavedKanbanView => {
      if (!v || typeof v !== 'object') return false;
      const obj = v as Record<string, unknown>;
      return typeof obj.id === 'string' && typeof obj.name === 'string';
    });
  });

  constructor(private deps: KanbanSavedViewsDeps) {}

  applySavedView(view: SavedKanbanView): void {
    this.deps.applyToFilters(view);
  }

  saveCurrentView(name: string): void {
    const boardId = this.deps.getBoardId();
    if (!boardId) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    // Same-name views replace existing entry — typing the same name again is
    // a natural "update this view" gesture and avoids stacking duplicates.
    const before = [...this.savedViews];
    const existing = this.savedViews.filter(
      (v) => v.name.toLowerCase() !== trimmed.toLowerCase(),
    );
    const snapshot = this.deps.getCurrentSnapshot();
    const view: SavedKanbanView = {
      id: createId(),
      name: trimmed,
      sortBy: snapshot.sortBy ?? 'manual',
      filterTags: snapshot.filterTags ?? [],
      filterProp: snapshot.filterProp ?? null,
    };
    const after = [...existing, view];
    // Phase 7 / 7.4 — route through history so Ctrl+Z reverses save / delete.
    historyStore.execute(
      new UpdateSavedViewsCommand(boardId, 'kanban', before, after, `Save view "${trimmed}"`),
    );
    this.deps.tickAndPersist();
  }

  deleteSavedView(id: string): void {
    const boardId = this.deps.getBoardId();
    if (!boardId) return;
    const before = [...this.savedViews];
    const next = this.savedViews.filter((v) => v.id !== id);
    if (next.length === before.length) return;
    const removed = before.find((v) => v.id === id);
    historyStore.execute(
      new UpdateSavedViewsCommand(
        boardId,
        'kanban',
        before,
        next,
        removed ? `Delete view "${removed.name}"` : 'Delete view',
      ),
    );
    this.deps.tickAndPersist();
  }
}
