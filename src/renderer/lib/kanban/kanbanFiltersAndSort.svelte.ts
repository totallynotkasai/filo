import { SvelteSet } from 'svelte/reactivity';
import type {
  KanbanBoard as KanbanBoardType,
  KanbanTilePlacement,
  Tile,
} from '../../schema/index';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { noteBody, noteTags } from '../../stores/noteMeta';
import { vaultPathForTile } from './kanbanFrontmatterWriter';

import { resolveTextTileVaultPath } from '../boards/textTilePath';
import { naturalCompare } from '../utils/naturalSort';
export type KanbanSortBy = 'manual' | 'title' | 'created' | 'dueDate' | 'priority';

export interface KanbanFilterProp {
  key: string;
  value: string;
}

export interface KanbanLastView {
  sortBy?: KanbanSortBy;
  filterTags?: string[];
  filterProp?: KanbanFilterProp | null;
}

export interface KanbanFiltersAndSortDeps {
  getBoardColumns: () => KanbanBoardType['columns'];
  getAllTilesById: () => Record<string, Tile>;
  getFindQuery: () => string;
  /** Bumps when the cache mutates so filter/sort derivations re-run. */
  getCacheVersion: () => number;
}

/**
 * Filter and sort controller for a Kanban board.
 *
 * Owns the transient (non-persistent until debounced) filter/sort UI state
 * — the host component is responsible for hydrating from
 * `settings.lastView` on board switch and persisting back via a debounced
 * effect. Hydration timing lives in the host because it tracks
 * "have we hydrated this board's filter state yet" via `hydratedForBoardId`.
 */
export class KanbanFiltersAndSort {
  activeFilterTags = $state<string[]>([]);
  activeFilterProp = $state<KanbanFilterProp | null>(null);
  activeSortBy = $state<KanbanSortBy>('manual');
  activeFilterMenu = $state(false);
  activeSortMenu = $state(false);

  constructor(private deps: KanbanFiltersAndSortDeps) {}

  /**
   * Returns true if a tile passes all currently-active filters (tag,
   * property, find-bar query). Touches `cacheVersion` so derivations
   * downstream re-run when Kanban mutators bump it through the proxy bridge.
   */
  tileMatchesFilters(tile: Tile): boolean {
    void this.deps.getCacheVersion();
    const tags = tile.tags ?? [];
    if (this.activeFilterTags.length > 0) {
      const path = vaultPathForTile(tile);
      // Through the tags normaliser: a note may write its tags as text.
      const fmTags = path ? noteTags(path) : [];
      const allTags = new SvelteSet<string>([
        ...tags.map((t) => String(t).replace(/^#/, '')),
        ...fmTags.map((t) => t.replace(/^#/, '')),
      ]);
      const wanted = this.activeFilterTags.map((t) => t.replace(/^#/, ''));
      const ok = wanted.every((w) => allTags.has(w));
      if (!ok) return false;
    }
    if (this.activeFilterProp && this.activeFilterProp.key) {
      const path = vaultPathForTile(tile);
      const fm = path ? (vaultIndexStore.getMetadata(path)?.frontmatter ?? {}) : {};
      const v = (fm as Record<string, unknown>)[this.activeFilterProp.key];
      const valueStr = String(v ?? '').toLowerCase();
      const want = this.activeFilterProp.value.toLowerCase();
      if (want && !valueStr.includes(want)) return false;
    }
    const query = this.deps.getFindQuery().trim().toLowerCase();
    if (query) {
      const haystack: string[] = [];
      haystack.push((tile.title || '').toLowerCase());
      for (const t of tags) haystack.push(String(t).toLowerCase());
      // Every card's text, mounted or not: a card's editor mounts only near
      // the view, so an unopened note is read from the vault index.
      const notePath = resolveTextTileVaultPath(tile);
      if (notePath) {
        const body = noteBody(notePath);
        if (body) haystack.push(body.toLowerCase());
      }
      const path = vaultPathForTile(tile);
      if (path) {
        for (const t of noteTags(path)) haystack.push(t.toLowerCase());
      }
      if (!haystack.some((s) => s.includes(query))) return false;
    }
    return true;
  }

  sortPlacements(
    placements: KanbanTilePlacement[],
    tilesById: Record<string, Tile>,
  ): KanbanTilePlacement[] {
    void this.deps.getCacheVersion();
    if (this.activeSortBy === 'manual') return placements;
    const sortBy = this.activeSortBy;
    const decorated = placements.map((p) => ({ p, t: tilesById[p.tileId] }));
    decorated.sort((a, b) => {
      const ta = a.t;
      const tb = b.t;
      if (!ta || !tb) return 0;
      if (sortBy === 'title') return naturalCompare(ta.title, tb.title);
      if (sortBy === 'created') return (ta.createdAt ?? 0) - (tb.createdAt ?? 0);
      const fmA = (vaultIndexStore.getMetadata(vaultPathForTile(ta) ?? '')?.frontmatter ?? {}) as Record<string, unknown>;
      const fmB = (vaultIndexStore.getMetadata(vaultPathForTile(tb) ?? '')?.frontmatter ?? {}) as Record<string, unknown>;
      // Cards without a value sort LAST; ties keep manual order because
      // Array.prototype.sort is stable.
      if (sortBy === 'dueDate') {
        const da = typeof fmA.dueDate === 'string' ? fmA.dueDate : '';
        const db = typeof fmB.dueDate === 'string' ? fmB.dueDate : '';
        if (!da || !db) return (da ? 0 : 1) - (db ? 0 : 1);
        // ISO dates: lexical order is chronological (no locale collation).
        return da < db ? -1 : da > db ? 1 : 0;
      }
      if (sortBy === 'priority') {
        const order = ['urgent', 'high', 'medium', 'low', 'none', ''];
        const rank = (v: unknown): number => {
          const i = order.indexOf(String(v ?? ''));
          return i < 0 ? order.length : i;
        };
        return rank(fmA.priority) - rank(fmB.priority);
      }
      return 0;
    });
    return decorated.map((d) => d.p);
  }

  visiblePlacementsForColumn(columnId: string): KanbanTilePlacement[] {
    const columns = this.deps.getBoardColumns();
    const col = columns.find((c) => c.id === columnId);
    if (!col) return [];
    const all = (col.tilePlacements ?? []) as KanbanTilePlacement[];
    const allTilesById = this.deps.getAllTilesById();
    const filtered = all.filter((p) => {
      const tile = allTilesById[p.tileId];
      return tile ? this.tileMatchesFilters(tile) : false;
    });
    return this.sortPlacements(filtered, allTilesById);
  }

  /** Whether any user-driven filter / find query is active right now. */
  isFilterActive(): boolean {
    return (
      this.activeFilterTags.length > 0
      || this.activeFilterProp !== null
      || this.deps.getFindQuery().trim().length > 0
    );
  }

  applyFilterTags(tags: string[]): void {
    this.activeFilterTags = tags;
  }

  applyFilterProperty(prop: KanbanFilterProp | null): void {
    this.activeFilterProp = prop;
  }

  applySortBy(sort: KanbanSortBy): void {
    this.activeSortBy = sort;
  }

  /**
   * Applies a saved view's filter/sort triplet. Same wire-up as
   * `hydrateFromLastView` minus the "no view → reset" branch — saved-view
   * application is always explicit, so there is no defaulting case.
   */
  applyView(view: { sortBy: KanbanSortBy; filterTags: string[]; filterProp: KanbanFilterProp | null }): void {
    this.activeSortBy = view.sortBy;
    this.activeFilterTags = [...view.filterTags];
    this.activeFilterProp = view.filterProp ? { ...view.filterProp } : null;
  }

  /**
   * Hydrates state from a board's persisted `settings.lastView`. A null /
   * malformed `lv` resets to manual + no filters explicitly so we don't
   * leak the previous board's state across a board switch.
   */
  hydrateFromLastView(lv: KanbanLastView | null): void {
    if (lv && typeof lv === 'object') {
      this.activeSortBy = lv.sortBy ?? 'manual';
      this.activeFilterTags = Array.isArray(lv.filterTags) ? [...lv.filterTags] : [];
      this.activeFilterProp = lv.filterProp ? { ...lv.filterProp } : null;
    } else {
      this.activeSortBy = 'manual';
      this.activeFilterTags = [];
      this.activeFilterProp = null;
    }
  }

  /** Snapshot of current state, suitable for persisting to `settings.lastView`. */
  snapshot(): KanbanLastView {
    return {
      sortBy: this.activeSortBy,
      filterTags: [...this.activeFilterTags],
      filterProp: this.activeFilterProp ? { ...this.activeFilterProp } : null,
    };
  }
}
