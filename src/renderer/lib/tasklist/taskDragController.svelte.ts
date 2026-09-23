/**
 * TaskDragController — drives Task List row drag via svelte-dnd-action.
 *
 * Each section in the rendered Task List Board mounts its own `dndzone`
 * sharing `type: 'tasklist-rows'`, so the library handles cross-section
 * drops natively. This controller owns the transient drag transaction state
 * (which tile is moving, what its multi-select block is, where the drag
 * started) plus the per-zone items mirrors that the dndzone's `items` prop
 * must point at.
 *
 * The component owns history / persist / frontmatter writes; the controller
 * routes each finalize through `commitIndent` / `commitOutdent` /
 * `commitReorder` callbacks so this module stays pure of store imports.
 *
 * `.svelte.ts` because the mirrors are reactive (`$state`) so the dndzone's
 * `items` prop re-runs each time we splice them.
 */

import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { type DndEvent } from 'svelte-dnd-action';
import { createIndentTracker, type IndentTracker } from './indentGesture';
import {
  resolveDragBlockIds,
  rebuildPlacementsFromDndItems,
  spliceBlockContiguous,
  type RowLike,
  type RowDndItem,
} from './blockMove';
import { moveTaskBlock } from '../tasks/taskMove';
import { sectionIdForPlacementIndex } from './sectionMath';
import type { TaskPlacement, TaskListSection } from '../../schema/index';

/**
 * Per-render snapshot of what the renderer wants the dndzones to look like.
 * The component recomputes this from `sectionedView` and pushes it into the
 * controller via `syncFromSnapshot()` whenever sections / placements change.
 */
export interface SectionItemsSnapshot {
  /** sectionId → row items currently visible in that section, in render
   * order (top-level + flattened subtasks). */
  itemsBySection: Record<string, RowDndItem[]>;
  /** sectionIds in the order their dndzones appear on screen. The leading
   * sentinel (when rendered) appears first. */
  displaySectionIds: string[];
  /** Sentinel id used by the renderer to key the synthetic leading bucket
   * (rows that live before the first persisted section). */
  leadingSectionId: string;
}

export interface TaskDragControllerOptions {
  /** Live rows for indent / depth / cycle classification at drop time. */
  getRows: () => RowLike[];
  /** Live placements before any drag-time mutation. */
  getPlacements: () => TaskPlacement[];
  /** Live persisted sections (excluding the synthetic leading + default). */
  getSections: () => TaskListSection[];
  /** Current multi-selection (anchor + others). */
  getSelectedTaskIds: () => Set<string>;
  /** Current render snapshot — sectionIds in render order, items per
   * section, leading sentinel id. */
  getSnapshot: () => SectionItemsSnapshot;
  /** Optional human-readable title for the dragged tile — used in screen-
   * reader announcements ("Picked up X", "Dropped X at position N"). When
   * omitted the controller falls back to a generic "task" label. */
  getTileTitle?: (tileId: string) => string | undefined;
  /** Optional human-readable label for a section — used in the "Hovering
   * position N of M in section S" announcement. The leading sentinel id
   * resolves to "Top". */
  getSectionTitle?: (sectionId: string) => string | undefined;
  /** True when `targetId` is a transitive descendant of `draggedId` —
   * indenting under it would create a cycle. */
  isCycleTarget: (draggedId: string, targetId: string) => boolean;
  /** True when `targetId` already sits at the deepest level a child can be
   * added under (depth cap == 2 → target at depth 2 rejects, since indent
   * would push the child to depth 3 which the model doesn't permit). */
  isDepthExceeded: (targetId: string) => boolean;
  /** Commit a single-row indent: row's `parent` frontmatter becomes `newParent`. */
  commitIndent: (tileId: string, newParent: string) => void;
  /** Commit a single-row outdent: row's `parent` frontmatter is cleared. */
  commitOutdent: (tileId: string) => void;
  /** Commit a structural reorder (sections + placements) via undo command. */
  commitReorder: (args: {
    nextPlacements: TaskPlacement[];
    nextSections: TaskListSection[];
    description: string;
    isMultiDrag: boolean;
    isCrossSection: boolean;
  }) => void;
  /** Polite-live-region announcement for screen readers. */
  announce: (msg: string) => void;
  /** Surface user-facing info (e.g. depth-cap rejected). Kind values match
   * `uiStore.toast`'s ToastMessage type. */
  toast: (msg: string, kind?: 'info' | 'success' | 'warning' | 'error', durationMs?: number) => void;
  /** Optional hook fired on drag enter/exit — components use it to bump
   * cacheVersion so derived badge counts re-evaluate mid-gesture. */
  onDragStateChange?: (active: boolean) => void;
}

/**
 * Class-based so the reactive `$state` fields live on instance properties
 * the component can read directly in template expressions. Spawn one per
 * mounted Task List Board (mount creates, destroy disposes).
 */
export class TaskDragController {
  /** Per-section dndzone items mirror. The dndzone's `items` prop reads
   * directly from this map; consider/finalize handlers splice it in place. */
  rowItemsBySection = $state<Record<string, RowDndItem[]>>({});
  /** Per-section drag-gate. Default `true` so a pointerdown on a row body
   * (text, checkbox, expand chevron) never starts a drag — only the
   * drag-handle's pointerdown arms its section. */
  rowDragDisabledBySection = $state<Record<string, boolean>>({});
  /** Tile id of the row currently being dragged, or `null`. Drives the
   * source-row CSS popout and gates the indent-gesture finalize logic. */
  dragTileId = $state<string | null>(null);
  /** The full set of tile ids participating in a multi-row drag. Empty
   * array for a solo drag (block is just `[dragTileId]`). */
  dragBlockIds = $state<string[]>([]);

  // ── Internal ──
  private liveItemsBySection: Record<string, RowDndItem[]> = {};
  private indentTracker: IndentTracker = createIndentTracker();
  private dragStartX = 0;
  private dragStartY = 0;
  private dragSourceSectionId: string | null = null;
  /** Tile id captured at pointerdown via `armRow`. Used to drop the
   *  consider-time block snapshot — by the time consider fires we already
   *  know which tile is moving and what the block was at pointerdown. */
  private pendingDragTileId: string | null = null;
  /** Set by `cancelByEscape()` and consumed by `onFinalizeRows` so the
   * synthetic pointerup that ESC dispatches unwinds dnd-action without
   * committing the reorder. Cleared on `endDrag()`. */
  private escCancelled = false;
  private escKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  /**
   * L16 (Audit-6) — the still-armed `armRow` pointerup, tracked so
   * `cancelDrag()` / `endDrag()` can detach it if the host unmounts while the
   * pointer is held. The `{ once: true }` closure would otherwise never fire,
   * pinning the controller and re-disabling drag gates on a disposed instance.
   * The listener nulls this itself on a normal release.
   */
  private pendingResetPointerUp: (() => void) | null = null;
  /** Debounced consider-announce so screen readers don't flood as the user
   * drags across many positions. Cleared by `endDrag()` and rate-limited to
   * one announcement per 300ms. */
  private hoverAnnounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAnnouncedSectionId: string | null = null;
  private lastAnnouncedIndex = -1;
  private opts: TaskDragControllerOptions;

  constructor(opts: TaskDragControllerOptions) {
    this.opts = opts;
  }

  /**
   * Mirror items from the current render snapshot into the mutable rowItems
   * map — but ONLY when no drag is in progress. Component invokes this
   * from an `$effect` that depends on the snapshot.
   *
   * Mirroring during a drag would overwrite the in-flight items the dndzone
   * is animating against, surfacing as snap-back or FLIP misalignment.
   */
  syncFromSnapshot(): void {
    if (this.dragTileId !== null) return;
    const snap = this.opts.getSnapshot();
    this.rowItemsBySection = { ...snap.itemsBySection };
    this.liveItemsBySection = { ...snap.itemsBySection };
    // Read the prior disabled map untracked so the calling $effect doesn't
    // take a dependency on the very state we're about to write (would cause
    // effect_update_depth_exceeded).
    const prevDisabled = untrack(() => this.rowDragDisabledBySection);
    const disabled: Record<string, boolean> = {};
    for (const sid of snap.displaySectionIds) {
      disabled[sid] = prevDisabled[sid] ?? true;
    }
    this.rowDragDisabledBySection = disabled;
  }

  /**
   * Drag-handle pointerdown handler. Enables EVERY section's dndzone for the
   * duration of this gesture (not just the source) so cross-section drops
   * land correctly — some svelte-dnd-action versions treat `dragDisabled` as
   * "this zone can't be a drop target" in addition to "can't initiate a
   * drag", which would silently revert any cross-section multi-drag.
   *
   * Captures the pointer's start coordinates for the indent tracker since
   * svelte-dnd-action doesn't surface them via `DndEvent`.
   *
   * `tileId` lets the controller snapshot `dragBlockIds` from the current
   * multi-selection AT pointerdown — matching Kanban's pattern. Snapshotting
   * later (at the first `consider` event) opens a race window where any
   * intervening selection mutation produces the wrong block, and the drag
   * silently falls through to the single-row branch (which appears to the
   * user as "selected tasks snap back to where they started").
   */
  armRow(sectionId: string, tileId: string, clientX: number, clientY: number): void {
    // Enable every section's zone for this gesture, snapshot which ones we
    // need to re-disable on pointerup. Only the source zone could possibly
    // initiate a new drag while this one is active, but `dragDisabled: true`
    // on a destination zone has bitten cross-section drops in practice.
    const nextDisabled: Record<string, boolean> = {};
    const previouslyDisabled: string[] = [];
    for (const sid of Object.keys(this.rowDragDisabledBySection)) {
      if (this.rowDragDisabledBySection[sid]) previouslyDisabled.push(sid);
      nextDisabled[sid] = false;
    }
    this.rowDragDisabledBySection = nextDisabled;

    this.dragStartX = clientX;
    this.dragStartY = clientY;
    this.pendingDragTileId = tileId;
    // Snapshot the multi-select block now so the consider-time refresh sees
    // a stable value and any mid-gesture selection mutation can't strand the
    // drag in the single-row branch.
    const sel = this.opts.getSelectedTaskIds();
    if (sel.has(tileId) && sel.size > 1) {
      this.dragBlockIds = Array.from(sel);
    } else {
      this.dragBlockIds = [];
    }

    const resetOnce = () => {
      this.pendingResetPointerUp = null;
      const reset: Record<string, boolean> = { ...this.rowDragDisabledBySection };
      for (const sid of previouslyDisabled) reset[sid] = true;
      // The source's section may not have been in `previouslyDisabled` if it
      // was already false. Re-disable it too so the lock-default invariant
      // is restored regardless of the starting state.
      reset[sectionId] = true;
      this.rowDragDisabledBySection = reset;
      this.pendingDragTileId = null;
    };
    // L16 — detach any prior still-armed reset (a second pointerdown with no
    // intervening pointerup) before arming this one, then track it so
    // cancelDrag()/endDrag() can detach on an unmount-while-pressed.
    this.detachPendingResetPointerUp();
    this.pendingResetPointerUp = resetOnce;
    window.addEventListener('pointerup', resetOnce, { once: true });
  }

  /** L16 — remove the still-armed `armRow` pointerup, if any. */
  private detachPendingResetPointerUp(): void {
    if (!this.pendingResetPointerUp) return;
    window.removeEventListener('pointerup', this.pendingResetPointerUp);
    this.pendingResetPointerUp = null;
  }

  /**
   * Stamps the cursor-following drag clone with a class our CSS uses to
   * rotate / scale / shadow the held row — visual parity with Kanban column
   * drag. Also force-clears opacity/visibility because some svelte-dnd-action
   * cancel paths leave the source element zeroed out.
   *
   * For multi-row drags, recompute the "+N" badge count to reflect only the
   * roots being dragged — block members whose parent is already in the block
   * are descendants that come along for the ride, not independent picks, and
   * counting them inflates the badge ("3 rows" when the user picked one
   * parent + two of its children should read "+0", not "+2").
   *
   * We mutate the clone element directly because the badge baked into the
   * source row's `data-drag-count` is captured at clone-time from the parent
   * component's `dragBlockIds.length - 1` expression — which counts every
   * member, including descendants.
   */
  readonly transformDraggedRow = (el?: HTMLElement): void => {
    if (!el) return;
    el.classList.add('tasklist-row-dragging');
    el.style.opacity = '';
    el.style.visibility = '';
    // Walk the cloned subtree for the row wrapper carrying the badge attr.
    // The clone wraps a `.task-item-wrap`; without descending, querySelector
    // is safer than relying on which element dnd-action handed us.
    const wrap = el.querySelector<HTMLElement>('.task-item-wrap')
      ?? (el.classList.contains('task-item-wrap') ? el : null);
    if (!wrap) return;
    if (this.dragBlockIds.length < 2) {
      wrap.setAttribute('data-drag-count', '0');
      return;
    }
    const blockSet = new SvelteSet(this.dragBlockIds);
    const parentOf = new SvelteMap<string, string>();
    for (const r of this.opts.getRows()) parentOf.set(r.tile.id, r.parent);
    let rootCount = 0;
    for (const id of this.dragBlockIds) {
      const p = parentOf.get(id) ?? '';
      if (!blockSet.has(p)) rootCount++;
    }
    const badge = Math.max(0, rootCount - 1);
    wrap.setAttribute('data-drag-count', String(badge));
  };

  /**
   * Svelte action that sweeps inline drag-leftover styles off every row
   * wrapper inside the zone after a reorder commit. svelte-dnd-action
   * writes `visibility: hidden`, `opacity`, `transform` on shadow items
   * during the drag and Svelte's keyed `{#each}` reuses those DOM nodes
   * after the commit — without this sweep, the stale style sticks to a
   * different row and the user sees a phantom-invisible row.
   *
   * Pass the section's `rowItemsBySection[sectionId]` as the trigger arg
   * so the action's `update` re-runs on every mirror change.
   */
  readonly clearStaleDndRowStyles = (node: HTMLElement, _trigger: unknown): { update(t: unknown): void; destroy(): void } => {
    const clear = () => {
      if (this.dragTileId !== null) return;
      const rows = node.querySelectorAll<HTMLElement>('.tasklist-row-wrap');
      rows.forEach((r) => {
        r.style.visibility = '';
        r.style.opacity = '';
        r.style.transform = '';
        r.classList.remove('tasklist-row-dragging');
      });
    };
    clear();
    return {
      update(_t: unknown) { clear(); },
      destroy() {},
    };
  };

  /**
   * Mirror items into the per-section map and, on the first consider event,
   * record the drag identity + install the indent pointer tracker.
   */
  onConsiderRows(sectionId: string, e: CustomEvent<DndEvent<RowDndItem>>): void {
    const items = e.detail.items;
    const info = e.detail.info;
    const draggedId = info.id;

    if (this.dragTileId === null && draggedId) {
      this.dragTileId = draggedId;
      this.dragSourceSectionId = sectionId;
      this.indentTracker.install(this.dragStartX, this.dragStartY);
      this.installEscCancel();
      // Block snapshot was taken at pointerdown in `armRow`. Only fall back
      // to a consider-time refresh if armRow didn't see this tile (e.g.
      // the drag was somehow initiated outside the drag-handle path, or a
      // unit test invoked the controller directly without armRow).
      if (this.pendingDragTileId !== draggedId) {
        this.refreshDragBlockIds();
      }
      this.opts.onDragStateChange?.(true);
      // Drag-start announcement — "Picked up task X".
      const title = this.tileLabel(draggedId);
      this.opts.announce(`Picked up task ${title}`);
    }
    // Note: we deliberately do NOT refresh dragBlockIds on subsequent
    // considers. The kanban pattern (snapshot at pointerdown, freeze for the
    // gesture) prevents a stray reactivity tick from clearing the selection
    // mid-drag and silently reverting the multi-block to a single-row drag.

    this.rowItemsBySection = { ...this.rowItemsBySection, [sectionId]: items };
    this.liveItemsBySection[sectionId] = items;
    // Debounced hover-position announce. We rate-limit so a fast drag across
    // 20 rows doesn't queue 20 SR utterances.
    this.scheduleHoverAnnounce(sectionId, items, draggedId);
  }

  private tileLabel(tileId: string): string {
    return this.opts.getTileTitle?.(tileId)?.trim() || 'task';
  }

  private sectionLabel(sectionId: string): string {
    const snap = this.opts.getSnapshot();
    if (sectionId === snap.leadingSectionId) return 'Top';
    return this.opts.getSectionTitle?.(sectionId)?.trim() || 'unnamed section';
  }

  private scheduleHoverAnnounce(
    sectionId: string,
    items: RowDndItem[],
    draggedId: string,
  ): void {
    const idx = items.findIndex((it) => it.id === draggedId);
    if (idx < 0) return;
    // Skip noise — same section + same position = no new information.
    if (this.lastAnnouncedSectionId === sectionId && this.lastAnnouncedIndex === idx) {
      return;
    }
    if (this.hoverAnnounceTimer) clearTimeout(this.hoverAnnounceTimer);
    this.hoverAnnounceTimer = setTimeout(() => {
      this.lastAnnouncedSectionId = sectionId;
      this.lastAnnouncedIndex = idx;
      const section = this.sectionLabel(sectionId);
      this.opts.announce(`Hovering position ${idx + 1} of ${items.length} in ${section}`);
      this.hoverAnnounceTimer = null;
    }, 300);
  }

  /**
   * Drop committed by the user. Classifies indent vs reorder vs cross-section
   * move and routes through the appropriate commit callback. Only the
   * destination zone (the one whose items contain the dragged tile) writes —
   * the source zone's matching finalize is treated as a no-op.
   */
  onFinalizeRows(sectionId: string, e: CustomEvent<DndEvent<RowDndItem>>): void {
    const items = e.detail.items;
    const info = e.detail.info;
    const draggedId = this.dragTileId ?? info.id;

    this.rowItemsBySection = { ...this.rowItemsBySection, [sectionId]: items };
    this.liveItemsBySection[sectionId] = items;

    if (!draggedId) {
      this.endDrag();
      return;
    }

    // ESC was pressed mid-drag. dnd-action's own pointerup unwind has restored
    // the items mirror to its pre-drag shape (or close enough); skip the
    // commit so the user's cancel intent is honoured without re-persisting
    // the snap-back as a fresh undo entry.
    if (this.escCancelled) {
      this.opts.announce('Drop cancelled');
      this.endDrag();
      return;
    }

    // Commit only on the destination zone. The source zone's finalize for a
    // cross-section drag fires with the dragged tile absent; ignore it and
    // wait for the destination's finalize on the next tick.
    if (!items.some((it) => it.id === draggedId)) {
      // If the drop was outside any zone, dnd-action restores items to the
      // pre-drag shape on every zone — we'll never see a destination
      // finalize with the dragged tile present. End the drag here so the
      // tracker / disabled flags reset cleanly even on cancel.
      if (this.dragTileId !== null) {
        // Defer end-of-drag to a microtask so any racing destination
        // finalize can still claim the commit before we tear down. In
        // practice the destination's finalize fires *before* the source's
        // for cross-section drops, so this is belt + suspenders.
        queueMicrotask(() => this.endDragIfStillNoDestination(draggedId));
      }
      return;
    }

    const placements = this.opts.getPlacements();
    const sections = this.opts.getSections();
    const snap = this.opts.getSnapshot();

    // The dragged tile vanished between drag-start and drop (deleted from a
    // second window, or removed by an external file-system change that
    // propagated mid-drag). Bailing here keeps the user's data intact instead
    // of writing a placement that points at a tile def that no longer exists.
    if (!placements.some((p) => p.tileId === draggedId)) {
      this.opts.toast('Task was removed before the drop completed', 'warning', 3000);
      this.endDrag();
      return;
    }

    const blockIds = resolveDragBlockIds(
      this.opts.getRows(),
      placements,
      this.dragBlockIds.length > 0 ? this.dragBlockIds : [draggedId],
    );
    const isMultiDrag = blockIds.length > 1;
    const isSameSection = this.dragSourceSectionId === sectionId;
    const indent = this.indentTracker.classify();

    // Indent / outdent: single-row only, same-section only. Multi-block
    // never indents — the visual shift would be ambiguous and the model
    // doesn't support parents per multi-selected row.
    if (!isMultiDrag && isSameSection) {
      if (indent.kind === 'indent' && indent.targetTileId && indent.targetTileId !== draggedId) {
        const targetId = indent.targetTileId;
        // DRAG-2 — `indent.targetTileId` is the row the pointer last hovered,
        // which can sit in a DIFFERENT section than the dragged row (easy near
        // a section boundary or over the leading bucket) even though the drop
        // finalized in the source section. Re-parenting `dragged` under a
        // foreign-section row would render it under that parent's section while
        // its placement stays here — the same divergence class as DRAG-1. Only
        // depth/cycle guarded it before; reject the cross-section case too.
        const draggedIdx = placements.findIndex((pl) => pl.tileId === draggedId);
        const targetIdx = placements.findIndex((pl) => pl.tileId === targetId);
        const crossSectionTarget =
          draggedIdx >= 0 &&
          targetIdx >= 0 &&
          sectionIdForPlacementIndex(sections, draggedIdx) !==
            sectionIdForPlacementIndex(sections, targetIdx);
        if (crossSectionTarget) {
          this.opts.toast('Cannot indent under a task in another section', 'info', 1800);
        } else if (this.opts.isDepthExceeded(targetId)) {
          this.opts.toast('Maximum subtask depth reached', 'info', 1800);
        } else if (this.opts.isCycleTarget(draggedId, targetId)) {
          this.opts.toast('Cannot indent under own subtask', 'info', 1800);
        } else {
          this.opts.commitIndent(draggedId, targetId);
          this.opts.announce(
            `Indented task ${this.tileLabel(draggedId)} under ${this.tileLabel(targetId)}`,
          );
        }
        this.endDrag();
        return;
      }
      if (indent.kind === 'outdent') {
        const draggedRow = this.opts.getRows().find((r) => r.tile.id === draggedId);
        if (draggedRow?.parent) {
          this.opts.commitOutdent(draggedId);
          this.opts.announce(`Outdented task ${this.tileLabel(draggedId)}`);
        }
        this.endDrag();
        return;
      }
    }

    // Multi-block: use the existing moveTaskBlock helper so block members
    // currently in other sections get pulled into the destination contiguous
    // with the anchor. dndzone items only reflect what we let the library
    // shuffle (anchor); non-anchor members are still in their source
    // sections' items mirrors.
    if (isMultiDrag) {
      const anchorIdxInDest = items.findIndex((it) => it.id === draggedId);
      const realTargetSectionId = sectionId === snap.leadingSectionId ? null : sectionId;
      const descendantIds = blockIds.filter((id) => id !== draggedId);
      const result = moveTaskBlock({
        placements,
        sections,
        draggedId,
        descendantIds,
        targetSectionId: realTargetSectionId,
        insertOffset: anchorIdxInDest,
      });

      const description = isSameSection
        ? `Reorder ${blockIds.length} tasks`
        : `Move ${blockIds.length} tasks`;
      this.opts.commitReorder({
        nextPlacements: result.placements,
        nextSections: result.sections,
        description,
        isMultiDrag: true,
        isCrossSection: !isSameSection,
      });
      const anchorIdx = result.placements.findIndex((p) => p.tileId === draggedId);
      this.opts.announce(
        `Dropped ${blockIds.length} tasks at position ${anchorIdx + 1} in ${this.sectionLabel(sectionId)}`,
      );
      this.endDrag();
      return;
    }

    // Single-row reorder branch: rebuild full placements from every
    // section's items mirror. dndzone events naturally reflect the new
    // ordering since the library splices anchor in/out of each zone.
    let rebuilt = rebuildPlacementsFromDndItems({
      placements,
      sections,
      displaySectionIds: snap.displaySectionIds,
      leadingSectionId: snap.leadingSectionId,
      itemsBySection: { ...this.liveItemsBySection },
    });

    // Defensive: if rebuild somehow loses the anchor (e.g. a zone missing
    // from the mirror), fall back to a no-op rather than persisting a
    // corrupt placements array. Should never trigger in practice — every
    // visible section gets its own dndzone.
    if (!rebuilt.placements.find((p) => p.tileId === draggedId)) {
      this.endDrag();
      return;
    }

    // Safety: block accidental contiguous-splice on single drag (no-op).
    rebuilt = {
      placements: spliceBlockContiguous(rebuilt.placements, draggedId, blockIds),
      sections: rebuilt.sections,
    };

    // DRAG-4 — a drop outside any zone (or back onto the same slot) leaves the
    // rebuilt placement order identical to the pre-drag order. Committing it
    // anyway pushes a phantom undo entry AND (under a non-manual sort) flips the
    // board to Manual with a misleading "Switched to Manual" toast. Skip the
    // commit when nothing actually moved (necessarily a same-section no-op —
    // any cross-section move changes the tile-id sequence).
    if (
      isSameSection &&
      rebuilt.placements.length === placements.length &&
      rebuilt.placements.every((pl, i) => pl.tileId === placements[i]?.tileId)
    ) {
      this.endDrag();
      return;
    }

    const description = isSameSection ? 'Reorder task' : 'Move task';
    this.opts.commitReorder({
      nextPlacements: rebuilt.placements,
      nextSections: rebuilt.sections,
      description,
      isMultiDrag: false,
      isCrossSection: !isSameSection,
    });
    // DRAG-1 — a single SUBTASK dragged into a DIFFERENT section: the rebuild
    // moves its placement into the new section, but `nestedView` re-nests it
    // under its (still-in-the-old-section) parent, so it renders under the
    // parent in the OLD section while its placement sits in the new one — the
    // drag appears to snap back yet `.board.json` is now internally
    // inconsistent. Clear its parent (outdent) so it becomes a top-level member
    // of its new section. The parent can't be in the new section (a tile lives
    // in exactly one section), so clearing is correct. Committed separately
    // (its own undo entry) to keep this off the host's commitReorder path.
    if (!isSameSection) {
      const draggedRow = this.opts.getRows().find((r) => r.tile.id === draggedId);
      if (draggedRow?.parent) this.opts.commitOutdent(draggedId);
    }
    const dropIdx = rebuilt.placements.findIndex((p) => p.tileId === draggedId);
    this.opts.announce(
      `Dropped task ${this.tileLabel(draggedId)} at position ${dropIdx + 1} in ${this.sectionLabel(sectionId)}`,
    );
    this.endDrag();
  }

  /** Force-end the drag transaction (e.g. component unmount, panic path). */
  cancelDrag(): void {
    // L16 — always detach the armRow pointerup, even when no drag actually
    // started (pointerdown armed it but the gesture never began), so an unmount
    // while the pointer is held doesn't leak the listener / pin the controller.
    this.detachPendingResetPointerUp();
    if (this.dragTileId === null) return;
    this.endDrag();
  }

  private endDragIfStillNoDestination(draggedId: string): void {
    if (this.dragTileId !== draggedId) return;
    // The destination's finalize already claimed the commit and cleared
    // state. Nothing to do.
    const stillNoDest = !Object.values(this.liveItemsBySection)
      .some((items) => items.some((it) => it.id === draggedId));
    if (stillNoDest) this.endDrag();
  }

  private refreshDragBlockIds(): void {
    if (!this.dragTileId) return;
    const sel = this.opts.getSelectedTaskIds();
    if (sel.has(this.dragTileId) && sel.size > 1) {
      this.dragBlockIds = Array.from(sel);
    } else {
      this.dragBlockIds = [];
    }
  }

  private endDrag(): void {
    this.dragTileId = null;
    this.dragBlockIds = [];
    this.dragSourceSectionId = null;
    this.pendingDragTileId = null;
    // L16 — belt-and-suspenders: a normal release fires resetOnce (nulling this)
    // before finalize → endDrag runs, so this is usually a no-op. It covers the
    // cancelDrag → endDrag and any drop-outside-zone path where the gate-reset
    // pointerup never ran.
    this.detachPendingResetPointerUp();
    this.indentTracker.uninstall();
    this.uninstallEscCancel();
    this.escCancelled = false;
    if (this.hoverAnnounceTimer) {
      clearTimeout(this.hoverAnnounceTimer);
      this.hoverAnnounceTimer = null;
    }
    this.lastAnnouncedSectionId = null;
    this.lastAnnouncedIndex = -1;
    this.opts.onDragStateChange?.(false);
  }

  /**
   * Installs a window keydown listener for ESC. When pressed during an active
   * drag we mark the transaction as cancelled and synthesise a pointerup at
   * the drag origin so svelte-dnd-action's own listener unwinds the FLIP and
   * fires `finalize` — at which point our cancel-aware branch in
   * `onFinalizeRows` bails before committing.
   *
   * Using a synthetic pointerup (rather than calling some private dnd-action
   * cancel API) keeps us decoupled from the library's internals: anything it
   * does on real release happens on the synthetic one too.
   */
  private installEscCancel(): void {
    if (this.escKeyHandler) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (this.dragTileId === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.escCancelled = true;
      const evt = new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientX: this.dragStartX,
        clientY: this.dragStartY,
        pointerType: 'mouse',
        button: 0,
        buttons: 0,
      });
      window.dispatchEvent(evt);
    };
    this.escKeyHandler = handler;
    window.addEventListener('keydown', handler, { capture: true });
  }

  private uninstallEscCancel(): void {
    if (!this.escKeyHandler) return;
    window.removeEventListener('keydown', this.escKeyHandler, { capture: true });
    this.escKeyHandler = null;
  }
}
