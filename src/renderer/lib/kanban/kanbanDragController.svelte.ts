import { type DndEvent } from 'svelte-dnd-action';
import { SvelteSet } from 'svelte/reactivity';
import type {
  KanbanBoard as KanbanBoardType,
  KanbanTilePlacement,
  Tile,
} from '../../schema/index';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { MoveCardCommand, MoveCardsCommand } from '../../commands/index';
import { isEditableTextTarget } from '../utils/editableTarget';
import type { KanbanSortBy } from './kanbanFiltersAndSort.svelte';
import { insertIndexAmongPlacements } from './kanbanInsertPosition';

const SORT_LABELS: Record<Exclude<KanbanSortBy, 'manual'>, string> = {
  title: 'title',
  created: 'date created',
  dueDate: 'due date',
  priority: 'priority',
};

/** Shape of items handed to the per-column card dndzones.
 *
 * `isDndShadowItem` is set by svelte-dnd-action when it splices its
 * placeholder into the items array during a drag. The render loop in
 * KanbanColumn.svelte branches on this so the placeholder paints as a
 * dashed drop-slot stub instead of a full KanbanCard — without that branch
 * the library's `visibility:hidden` leaks onto an adjacent real card via
 * Svelte's keyed `{#each}` node reuse.
 */
export interface KanbanCardDndItem {
  id: string;
  isDndShadowItem?: boolean;
}

export interface KanbanDragControllerDeps {
  getBoardId: () => string | null;
  getColumns: () => KanbanBoardType['columns'];
  getAllTilesById: () => Record<string, Tile>;
  getActiveSortBy: () => KanbanSortBy;
  reorderColumns: (orderedIds: string[]) => void;
  tickAndPersist: () => void;
  /** Live selection state. The controller reads this at pointerdown to
   *  decide whether the drag is single or multi-card. Returns the set of
   *  currently-selected tile IDs (empty when nothing is selected). */
  getSelectedTileIds: () => ReadonlySet<string>;
  /** Board-flat ordered list of visible tile IDs. Drives the order block
   *  members are dropped into the destination column. */
  getFlatVisibleTileIds: () => string[];
}

/**
 * Drag controller for the Kanban board.
 *
 * Owns the drag-state shared between card-move and column-reorder, both
 * svelte-dnd-action zones. The host keeps the `dndColumns` sync `$effect`
 * because effects fired from external class constructors do not unwrap
 * reliably — the controller exposes `syncColumns(c)` for the host to call.
 *
 * Each column's card zone is fed only the cards it shows, in the order it
 * shows them (`syncCards`): dnd-action maps its `items` onto the zone's
 * rendered children one to one, so a hidden (filtered) card in `items`
 * would shift every index and the drag would pick the wrong card. A drop
 * is then translated back into the column's full placement order, where
 * the hidden cards keep their places.
 */
export class KanbanDragController {
  dragTileId = $state<string | null>(null);
  dragSourceColumnId = $state<string | null>(null);
  dropTargetColumnId = $state<string | null>(null);
  dropTargetIndex = $state<number | null>(null);

  // Column reorder via svelte-dnd-action. Header acts as the drag handle:
  // `columnDragDisabled` starts true so a pointerdown in the column body
  // or cards never initiates a column drag. The header's pointerdown
  // flips it false; pointerup or finalize resets it.
  columnDragDisabled = $state(true);

  // ── Card drag (svelte-dnd-action, per-column zones) ──
  //
  // Each column mounts its own dndzone with `type: 'kanban-cards'` so the
  // library handles cross-column moves natively. `cardDragDisabled` starts
  // true so a click on text inside a card body never starts a drag; a
  // pointerdown on a non-editable region of the card flips it false for one
  // gesture (pattern mirrors `columnDragDisabled`).
  cardDragDisabled = $state(true);
  /** Per-column items mirror — the dndzone's `items` prop points here. */
  dndCardsByColumn = $state<Record<string, KanbanCardDndItem[]>>({});
  /** Snapshot of the items per column at drag-start. Used by `onFinalizeCards`
   *  to recover the source column + index when the destination commits. */
  private dndCardsBeforeDrag: Record<string, KanbanCardDndItem[]> = {};

  /**
   * Ordered tile IDs participating in the current drag.
   *
   * Single-card drag → just `[anchorTileId]`. Multi-card drag (started on a
   * selected card while the selection has 2+ unlocked members) → every
   * selected unlocked card ordered by board-flat visual position. The
   * library only knows about the anchor; non-anchor members live in their
   * source columns during the drag and are committed together via
   * `MoveCardsCommand` on finalize.
   */
  dragBlockIds = $state<string[]>([]);

  /** Pre-drag snapshot of every block member's source column + position.
   *  Used to build `MoveCardsCommand`'s undo data. */
  private dragBlockSnapshots: Array<{ tileId: string; fromColumnId: string; fromPosition: number }> = [];

  // Local mirror of column ordering used by dndzone. svelte-dnd-action
  // *requires* the items array to be committed back via the consider /
  // finalize event handlers — if we just hand it `columns` directly the
  // library snaps the DOM back to that array on drop. The mirror is the
  // committed source of truth between drag start and finalize.
  dndColumns = $state<KanbanBoardType['columns']>([]);

  /**
   * Live `prefers-reduced-motion` flag. Drives `cardFlipDurationMs` so the
   * dndzone skips its FLIP animation when the OS asks for reduced motion.
   * Updated via a `matchMedia` `change` listener; the host calls `dispose()`
   * on unmount to detach it.
   */
  reduceMotion = $state(false);
  private mediaQuery: MediaQueryList | null = null;
  private mediaListener: ((e: MediaQueryListEvent) => void) | null = null;

  /**
   * Window `pointerup` listeners armed by a pointerdown that
   * hasn't fired yet (card / column drag-gate reset). Tracked so `dispose()`
   * can detach them if the host unmounts while the pointer is still held —
   * otherwise the `{ once: true }` closure never fires, pinning the controller
   * and (harmlessly but wastefully) mutating a disposed instance on a later
   * release. A normal pointerup auto-removes its own entry via the wrapper.
   */
  private pendingPointerUps = new SvelteSet<() => void>();

  /**
   * True once svelte-dnd-action has reported a real card drag (`consider`).
   * A press and release without movement gets no event from the library, so
   * the pointerup check in `onCardPointerDown` is the only thing that ends
   * such a gesture.
   */
  private dragStarted = false;
  /** The deferred end-of-click check, cleared on dispose. */
  private clickEndTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: KanbanDragControllerDeps) {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reduceMotion = this.mediaQuery.matches;
      this.mediaListener = (e) => {
        this.reduceMotion = e.matches;
      };
      this.mediaQuery.addEventListener('change', this.mediaListener);
    }
  }

  /** FLIP animation duration for the card dndzone. 180ms by default (longer
   *  feels sluggish now that sibling cards animate). Zero under
   *  `prefers-reduced-motion: reduce` so the OS pref wins.
   */
  get cardFlipDurationMs(): number {
    return this.reduceMotion ? 0 : 180;
  }

  dispose(): void {
    if (this.mediaQuery && this.mediaListener) {
      this.mediaQuery.removeEventListener('change', this.mediaListener);
      this.mediaQuery = null;
      this.mediaListener = null;
    }
    // Detach any pointerup listener still armed at unmount (pointer held
    // through teardown). A normal release removes its own entry first.
    for (const handler of this.pendingPointerUps) {
      window.removeEventListener('pointerup', handler);
    }
    this.pendingPointerUps.clear();
    if (this.clickEndTimer !== null) {
      clearTimeout(this.clickEndTimer);
      this.clickEndTimer = null;
    }
  }

  /**
   * Arm a one-shot window `pointerup` that re-locks a drag gate, tracking
   * the handler so `dispose()` can detach it if the host unmounts before the
   * release fires. The wrapper deletes its own tracking entry when it runs, so
   * the steady-state (press → release) path leaves nothing behind.
   */
  private armPointerUp(onUp: () => void): void {
    const handler = (): void => {
      this.pendingPointerUps.delete(handler);
      onUp();
    };
    this.pendingPointerUps.add(handler);
    window.addEventListener('pointerup', handler, { once: true });
  }

  /**
   * Sync the dnd mirror from the host's canonical `columns` whenever
   * `columnDragDisabled` is true. The host owns the `$effect` that calls
   * this — see KanbanBoard.svelte's dndColumns sync effect.
   *
   * Tracking `columnDragDisabled` inside the host effect's dependency
   * graph caused snap-back: an intermediate flag flip overwrote the
   * just-committed mirror with stale columns before the store mutation
   * propagated. The host uses `untrack` around this call.
   */
  syncColumns(columns: KanbanBoardType['columns']): void {
    if (this.columnDragDisabled) {
      this.dndColumns = columns;
    }
  }

  /**
   * Rebuild `dndCardsByColumn` from the cards each column shows, in the order
   * it shows them (filtered and sorted). The items must be exactly the
   * rendered cards: a hidden card in `items` has no DOM node, so the library
   * would pick the wrong card. Skipped while a card drag is in progress so
   * the dndzone keeps its in-flight items (otherwise we'd snap the dragged
   * item back). The host calls this from an `$effect` (untracked, like
   * `syncColumns`).
   */
  syncCards(visibleByColumn: Record<string, string[]>): void {
    if (this.dragTileId !== null) return;
    const next: Record<string, KanbanCardDndItem[]> = {};
    for (const [colId, ids] of Object.entries(visibleByColumn)) {
      next[colId] = ids.map((id) => ({ id }));
    }
    this.dndCardsByColumn = next;
  }

  /** The column's card ids in the board's saved (manual) order. */
  private placementIds(columnId: string): string[] {
    const col = this.deps.getColumns().find((c) => c.id === columnId);
    return ((col?.tilePlacements ?? []) as KanbanTilePlacement[]).map((p) => p.tileId);
  }

  /**
   * Card pointerdown — arms the per-card dndzone for one drag gesture.
   * Filters out editable text targets (TipTap body) and interactive children
   * so click-to-edit and inline buttons keep working. Re-locks on pointerup,
   * and ends a press that never became a drag there: while `dragTileId` is
   * set `syncCards` skips every column, so a plain click would otherwise
   * leave the board showing stale cards until the next real drag.
   *
   * Multi-card drag: if the anchor is part of a 2+ selection of unlocked
   * cards, snapshot the full block (anchor + every other selected unlocked
   * card) in board-flat order. The library only moves the anchor through
   * its items array; `onFinalizeCards` reads `dragBlockIds` to commit a
   * `MoveCardsCommand` that lands every block member contiguous with the
   * anchor in the destination column.
   */
  onCardPointerDown = (e: PointerEvent, tileId: string, locked: boolean): void => {
    if (e.button !== 0) return;
    if (locked) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && isEditableTextTarget(tgt)) return;
    if (tgt && tgt.closest('button, a, input, textarea, select')) return;
    this.cardDragDisabled = false;
    this.dragStarted = false;
    this.armPointerUp(() => {
      this.cardDragDisabled = true;
      // One task later, so a drop's own events run first. A real drag's
      // finalize can come later still (after the drop animation); it ends
      // the drag itself, and `dragStarted` keeps this check out of its way.
      if (this.clickEndTimer !== null) clearTimeout(this.clickEndTimer);
      this.clickEndTimer = setTimeout(() => {
        this.clickEndTimer = null;
        if (!this.dragStarted) this.resetCardDrag();
      }, 0);
    });
    this.dragTileId = tileId;
    this.dragBlockIds = this.computeDragBlockIds(tileId);
    this.dragBlockSnapshots = this.snapshotBlockPlacements(this.dragBlockIds);
    // Snapshot every column's items so finalize can recover the source column
    // / index even after the library has spliced the dragged item out.
    this.dndCardsBeforeDrag = {};
    for (const [colId, items] of Object.entries(this.dndCardsByColumn)) {
      this.dndCardsBeforeDrag[colId] = items.slice();
    }
  };

  /**
   * Build the ordered drag block for `anchorTileId`. Returns `[anchor]` when
   * the anchor isn't part of a multi-selection or only itself is selected;
   * otherwise returns every selected unlocked tile sorted by board-flat
   * visual position.
   */
  private computeDragBlockIds(anchorTileId: string): string[] {
    const selected = this.deps.getSelectedTileIds();
    if (!selected.has(anchorTileId) || selected.size < 2) {
      return [anchorTileId];
    }
    const allTiles = this.deps.getAllTilesById();
    const flat = this.deps.getFlatVisibleTileIds();
    const ordered: string[] = [];
    for (const id of flat) {
      if (!selected.has(id)) continue;
      if (id !== anchorTileId && allTiles[id]?.locked === true) continue;
      ordered.push(id);
    }
    // Anchor is always part of the block even if it falls outside `flat`
    // (e.g. when it's only visible thanks to the dragTileId override).
    if (!ordered.includes(anchorTileId)) ordered.unshift(anchorTileId);
    return ordered;
  }

  /** Look up each tile's current (column, position) for the undo snapshot. */
  private snapshotBlockPlacements(
    tileIds: string[],
  ): Array<{ tileId: string; fromColumnId: string; fromPosition: number }> {
    const out: Array<{ tileId: string; fromColumnId: string; fromPosition: number }> = [];
    const idSet = new SvelteSet(tileIds);
    for (const col of this.deps.getColumns()) {
      const placements = (col.tilePlacements ?? []) as KanbanTilePlacement[];
      placements.forEach((p, i) => {
        if (idSet.has(p.tileId)) {
          out.push({ tileId: p.tileId, fromColumnId: col.id, fromPosition: i });
        }
      });
    }
    return out;
  }

  /**
   * `consider` is fired continuously while the user drags — splice the
   * dndzone's new ordering into our mirror so the items prop reflects the
   * in-flight order. No commit here; the move is committed on `finalize`.
   */
  onConsiderCards = (columnId: string, e: CustomEvent<DndEvent<KanbanCardDndItem>>): void => {
    this.dragStarted = true;
    this.dndCardsByColumn = {
      ...this.dndCardsByColumn,
      [columnId]: e.detail.items,
    };
  };

  /**
   * `finalize` fires on both source and destination zones at drop time. We
   * commit only on the destination — the zone whose items now contain the
   * dragged tile — and look up the source column + index from the pre-drag
   * snapshot. The source zone's finalize updates the mirror only.
   */
  onFinalizeCards = (columnId: string, e: CustomEvent<DndEvent<KanbanCardDndItem>>): void => {
    const items = e.detail.items;
    const draggedId = this.dragTileId ?? e.detail.info.id;

    this.dndCardsByColumn = {
      ...this.dndCardsByColumn,
      [columnId]: items,
    };

    if (!draggedId) {
      this.resetCardDrag();
      return;
    }

    // Commit only on the destination zone (the one now containing the tile).
    const dropIdx = items.findIndex((it) => it.id === draggedId);
    if (dropIdx < 0) {
      // The source zone's finalize after a drop in another column: that
      // column's finalize fired first and committed. A drop outside every
      // zone puts the card back in its source, so it lands on the no-op
      // path below.
      return;
    }

    // Find the source column from the pre-drag snapshot.
    let fromColumnId: string | null = null;
    for (const [colId, snap] of Object.entries(this.dndCardsBeforeDrag)) {
      if (snap.some((it) => it.id === draggedId)) {
        fromColumnId = colId;
        break;
      }
    }

    const boardId = this.deps.getBoardId();
    if (!boardId || !fromColumnId) {
      this.resetCardDrag();
      return;
    }

    // A sorted column shows the sort's order, so a reorder inside it would
    // be saved but never seen. Refuse it and put the cards back.
    const sortBy = this.deps.getActiveSortBy();
    if (sortBy !== 'manual' && fromColumnId === columnId) {
      this.dndCardsByColumn = {
        ...this.dndCardsByColumn,
        [columnId]: this.dndCardsBeforeDrag[columnId] ?? items,
      };
      uiStore.toast(`Cards are sorted by ${SORT_LABELS[sortBy]}. Switch to Manual sort to reorder them.`, 'info', 3500);
      this.resetCardDrag();
      return;
    }

    const isMultiDrag = this.dragBlockIds.length > 1;
    // `items` holds only the cards on screen, so the drop is placed in the
    // saved order next to the visible neighbour it was dropped by.
    const fromPosition = this.placementIds(fromColumnId).indexOf(draggedId);
    if (fromPosition < 0) {
      this.resetCardDrag();
      return;
    }
    const toPosition = insertIndexAmongPlacements(
      items.map((it) => it.id),
      draggedId,
      new SvelteSet(isMultiDrag ? this.dragBlockIds : [draggedId]),
      this.placementIds(columnId),
    );

    // No-op detection: a single card put back in its own place.
    if (!isMultiDrag && fromColumnId === columnId && fromPosition === toPosition) {
      this.resetCardDrag();
      return;
    }

    if (isMultiDrag) {
      historyStore.execute(
        new MoveCardsCommand(
          boardId,
          this.dragBlockIds,
          columnId,
          toPosition,
          this.dragBlockSnapshots,
        ),
      );
      this.deps.tickAndPersist();
      uiStore.toast(
        `Moved ${this.dragBlockIds.length} cards`,
        'success',
        1500,
      );
      this.resetCardDrag();
      return;
    }

    historyStore.execute(
      new MoveCardCommand(boardId, draggedId, fromColumnId, fromPosition, columnId, toPosition),
    );
    this.deps.tickAndPersist();
    this.resetCardDrag();
  };

  private resetCardDrag(): void {
    this.dragStarted = false;
    this.dragTileId = null;
    this.dragSourceColumnId = null;
    this.dropTargetColumnId = null;
    this.dropTargetIndex = null;
    this.dndCardsBeforeDrag = {};
    this.dragBlockIds = [];
    this.dragBlockSnapshots = [];
  }

  /**
   * Stamps the cursor-following card clone with a class our CSS uses to
   * lift the card off the column (rotate + scale + shadow). Mirrors the
   * column-drag visual treatment.
   *
   * Multi-card drag: stamps a `data-drag-count` attribute on the inner
   * `.kanban-card-shell` so CSS can paint a "+N" badge — N is the number
   * of *additional* cards travelling with the anchor (so a 3-card drag
   * shows "+2"). Mirrors the Task List multi-row badge.
   */
  transformDraggedCard = (el?: HTMLElement): void => {
    if (!el) return;
    el.classList.add('kanban-card-dragging');
    // Some svelte-dnd-action cancel paths leave the clone opacity-0 on
    // abort; force-clear so the dropped card is always visible.
    el.style.opacity = '';
    el.style.visibility = '';
    // Badge attribute lands on the outer clone wrapper, NOT the inner
    // `.kanban-card-shell` — the shell has `overflow:hidden` so its
    // `::after` would be clipped.
    const extras = Math.max(0, this.dragBlockIds.length - 1);
    el.setAttribute('data-drag-count', String(extras));
  };

  /**
   * Svelte action that sweeps inline drag-leftover styles off every card
   * wrapper inside the zone after each consider/finalize.
   *
   * Defensive safety net. Real cards going invisible mid-drag is prevented at
   * the render site (KanbanColumn.svelte renders `.kanban-drop-slot` with a
   * `_shadow` key suffix so svelte-dnd-action always has a shadow DOM node to
   * hide), so this sweep shouldn't catch anything in the happy path.
   *
   * Kept for cancel paths (Escape / drag-outside-any-zone) where the library
   * can leave inline `opacity`/`transform` on the source `.tile-drop-zone`
   * before its own cleanup runs. Pass the column's cardItems mirror as the
   * trigger arg so `update` re-fires on every consider event. Mirrors
   * `clearStaleDndRowStyles` in the Task List drag controller.
   */
  readonly clearStaleDndCardStyles = (
    node: HTMLElement,
    _trigger: unknown,
  ): { update(t: unknown): void; destroy(): void } => {
    const clear = (): void => {
      if (this.dragTileId !== null) return;
      node.querySelectorAll<HTMLElement>('.tile-drop-zone').forEach((c) => {
        c.style.visibility = '';
        c.style.opacity = '';
        c.style.transform = '';
      });
    };
    clear();
    return {
      update(_t: unknown): void { clear(); },
      destroy(): void {},
    };
  };

  // ── Column drag/drop (reorder via svelte-dnd-action) ──

  /**
   * Header pointerdown: enables column dragging for the next pointer gesture.
   * Re-disables on pointerup (no drag started) or in onfinalize (drag
   * landed) so other interactions stay click-only.
   */
  onColumnHeaderPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest('button, a, input, textarea, select')) return;
    this.columnDragDisabled = false;
    this.armPointerUp(() => {
      this.columnDragDisabled = true;
    });
  };

  onConsiderColumns = (e: CustomEvent<{ items: KanbanBoardType['columns'] }>): void => {
    this.dndColumns = e.detail.items;
  };

  onFinalizeColumns = (e: CustomEvent<{ items: KanbanBoardType['columns'] }>): void => {
    // Commit the new order to the store FIRST so `columns` (and our sync
    // effect, when it later runs) sees the new ordering. Then update the
    // mirror so the dndzone's items prop reflects the committed order on
    // the very next render. Re-disable drag last.
    this.deps.reorderColumns(e.detail.items.map((c) => c.id));
    this.dndColumns = e.detail.items;
    this.columnDragDisabled = true;
  };

  /**
   * Tags the cursor-following clone with a class our CSS uses to lift the
   * column out of the row (rotate + scale + shadow). svelte-dnd-action calls
   * this on every dragmove tick with the same element reference.
   */
  transformDraggedColumn = (el?: HTMLElement): void => {
    if (!el) return;
    el.classList.add('kanban-column-dragging');
  };
}
