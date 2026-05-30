import { canvasStore } from '../../stores/canvas.svelte';
import { boardStore } from '../../stores/board.svelte';
import { selectionStore } from '../../stores/selection.svelte';
import { historyStore } from '../../stores/history.svelte';
import { guidesStore } from '../../stores/guides.svelte';
import { spatialStore } from '../../stores/spatial.svelte';
import { framesStore } from '../../stores/frames.svelte';
import { MoveTilesCommand } from '../../commands/index';
import { computeGuides, capCandidatesByDistance, type TileBounds } from './smartGuides';
import { startEdgePan, stopEdgePan, updateEdgePanMouse } from './edgePan';

/**
 * Tile drag action — applied to the tile header element.
 * Tracks pointer movement and updates tile position in the board store.
 * Supports multi-select drag (moves all selected tiles together).
 * Creates a single MoveTilesCommand on drag end for undo/redo.
 *
 * Usage: <div use:tileDragAction={{ tileId, locked }}>...</div>
 */

export interface TileDragOptions {
  tileId: string;
  locked: boolean;
  snapToGrid?: boolean;
  gridSize?: number;
}

const GRID_SIZE = 20;

/**
 * Sprint B / B7 — upper bound on the number of neighbour tiles fed into
 * `computeGuides` per move frame. The rbush viewport query already narrows
 * the candidate set to the visible region, but a dense board can still
 * surface thousands of tiles inside the viewport. `computeGuides` is
 * O(n * 36) (3 vertical × 3 horizontal alignment checks per other tile),
 * so an uncapped n is a frame killer at ~1000+ tiles. The cap is chosen
 * empirically — large enough to cover the cluster of tiles a user typically
 * cares about aligning with, small enough to keep per-frame work under
 * 16ms on a 1000-tile board.
 */
const SMART_GUIDE_MAX_CANDIDATES = 100;

export function tileDragAction(node: HTMLElement, options: TileDragOptions) {
  let currentOptions = options;
  let isDragging = false;
  let hasMoved = false;
  let edgePanStarted = false;
  let startX = 0;
  let startY = 0;
  // Capture the canvas pan at drag start so edge-panning during the drag
  // can be subtracted from the screen-space delta. Without this, the tile
  // appears to "stop following" the cursor once the canvas auto-pans.
  let startPanX = 0;
  let startPanY = 0;
  let startPositions: Map<string, { x: number; y: number }> = new Map();
  // Phase 27 / A2 — capture the pointerId so a mid-drag Escape can release
  // it without an event of its own. pointerup/pointercancel still come with
  // their event, but Escape arrives via window keydown so the capturing
  // node has to remember which pointer to free.
  let activePointerId: number | null = null;

  // rAF coalescing: raw pointermove fires faster than the compositor can
  // present. We store the latest event and run the heavy move body at most
  // once per frame, using the freshest event. Edge-pan still needs the latest
  // mouse coords every raw event, so it's updated synchronously outside the
  // batched body.
  let pendingEvent: PointerEvent | null = null;
  let rafId: number | null = null;

  // Smart-guides micro-throttle: track the last raw input delta we evaluated
  // guides against. Skip re-evaluation when the cursor has moved less than 2
  // world-pixels since — too small to change snap targets. Tracking the raw
  // (pre-snap) delta lets the user pull out of a snap immediately. We also
  // cache the most recent snap offset so skipped frames still apply the
  // current snap (tiles don't pop between evaluations).
  let lastGuideEvalDx = NaN;
  let lastGuideEvalDy = NaN;
  let lastSnapDx = 0;
  let lastSnapDy = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return; // left click only

    const target = e.target as HTMLElement;
    const onInteractive =
      target.closest('button') ||
      target.closest('input') ||
      target.closest('textarea') ||
      target.closest('[contenteditable]') ||
      target.closest('.header-btn') ||
      target.closest('.tile-title');

    // Selecting on header pointerdown is allowed even for locked tiles —
    // "locked" gates dragging, not selection. Skip the selection update on
    // interactive children (buttons, title editor, etc.) so their own
    // handlers retain control.
    if (!onInteractive) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        selectionStore.toggle(currentOptions.tileId);
      } else if (!selectionStore.isSelected(currentOptions.tileId)) {
        selectionStore.select(currentOptions.tileId);
      }
    }

    if (currentOptions.locked) return;
    if (onInteractive) return;

    e.stopPropagation();
    isDragging = true;
    hasMoved = false;
    edgePanStarted = false;
    startX = e.clientX;
    startY = e.clientY;
    startPanX = canvasStore.transform.x;
    startPanY = canvasStore.transform.y;
    lastGuideEvalDx = NaN;
    lastGuideEvalDy = NaN;
    lastSnapDx = 0;
    lastSnapDy = 0;

    // Capture starting positions of all tiles to move:
    // includes selected tiles AND their group members
    const baseIds = selectionStore.isSelected(currentOptions.tileId)
      ? [...selectionStore.selectedIds]
      : [currentOptions.tileId];

    // Expand to include all group members
    const idsToMove = new Set(baseIds);
    for (const id of baseIds) {
      for (const gid of boardStore.getGroupedTileIds(id)) {
        idsToMove.add(gid);
      }
    }

    startPositions = new Map();
    for (const id of idsToMove) {
      const tile = boardStore.getTile(id);
      if (tile) {
        startPositions.set(id, { x: tile.position.x, y: tile.position.y });
      }
    }

    // Suppress spatial-store revision bumps for the duration of the drag.
    // The rbush still mutates per move (so the in-flight smart-guides query
    // sees a consistent index for non-dragged neighbours), but viewport
    // culling re-derives exactly once on release instead of once per tile
    // per frame.
    spatialStore.beginBatch();

    node.setPointerCapture(e.pointerId);
    activePointerId = e.pointerId;
    document.body.style.cursor = 'grabbing';
    // Phase 27 / A2 — activate Escape-cancel only while a drag is in flight.
    // Registering on every pointerdown (not on mount) avoids a global keydown
    // hook on every tile in the document. Removed in pointerup / pointercancel /
    // cancelDrag / destroy so it can never outlive the gesture.
    window.addEventListener('keydown', onWindowKeyDown, true);
    // Edge pan is deferred to the first pointermove to avoid stale mouse coords
  }

  /**
   * Phase 27 / A2 — Escape during a drag restores every captured start
   * position, suppresses the would-be MoveTilesCommand (hasMoved=false),
   * and tears down the drag state in the same shape as `onPointerCancel`.
   * Capture phase + stopPropagation so the keydown can't bubble into TipTap
   * editors or shortcut handlers that might be focused inside a dragged tile.
   */
  function onWindowKeyDown(e: KeyboardEvent) {
    if (!isDragging || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancelDrag();
  }

  function cancelDrag(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      pendingEvent = null;
    }
    // Restore each tile to its drag-start position. `boardStore.updateTile`
    // mirrors the change into the spatial index, so no separate spatial call
    // is needed here.
    for (const [id, startPos] of startPositions) {
      if (boardStore.getTile(id)) {
        boardStore.updateTile(id, { position: { x: startPos.x, y: startPos.y } });
      }
    }
    // hasMoved=false on the off chance pointerup still fires after the
    // cancel; with isDragging=false the early-return at the top of
    // onPointerUp handles it, but belt-and-braces against a future code
    // path that bypasses the guard.
    hasMoved = false;
    isDragging = false;
    startPositions.clear();
    if (activePointerId !== null) {
      try { node.releasePointerCapture(activePointerId); } catch { /* already released */ }
      activePointerId = null;
    }
    document.body.style.cursor = '';
    if (edgePanStarted) {
      stopEdgePan();
      edgePanStarted = false;
    }
    guidesStore.clear();
    spatialStore.endBatch();
    window.removeEventListener('keydown', onWindowKeyDown, true);
  }

  function onPointerMove(e: PointerEvent) {
    if (!isDragging) return;

    // Edge-pan needs the freshest mouse coords every raw event so its rAF
    // loop never operates on stale data — keep this synchronous.
    if (!edgePanStarted) {
      updateEdgePanMouse(e.clientX, e.clientY);
      // Tile drag is pointer-captured to the active pane, so the global
      // facade resolves to the right canvas for the whole gesture (Audit 5.4).
      startEdgePan(canvasStore);
      edgePanStarted = true;
    }
    updateEdgePanMouse(e.clientX, e.clientY);

    pendingEvent = e;
    if (rafId === null) {
      rafId = requestAnimationFrame(flushMove);
    }
  }

  function flushMove() {
    rafId = null;
    const e = pendingEvent;
    pendingEvent = null;
    if (!isDragging || !e) return;
    runMoveBody(e);
  }

  function runMoveBody(e: PointerEvent) {
    hasMoved = true;

    const scale = canvasStore.scale;
    // Subtract the pan accumulated during the drag so the tile keeps
    // tracking the cursor in world space while edge-pan auto-shifts the
    // canvas underneath it.
    const panDx = canvasStore.transform.x - startPanX;
    const panDy = canvasStore.transform.y - startPanY;
    const dx = ((e.clientX - startX) - panDx) / scale;
    const dy = ((e.clientY - startY) - panDy) / scale;

    const gridSize = currentOptions.snapToGrid ? (currentOptions.gridSize || GRID_SIZE) : 0;

    // Compute positions for all dragged tiles
    const newPositions = new Map<string, { x: number; y: number }>();
    for (const [id, startPos] of startPositions) {
      let newX = startPos.x + dx;
      let newY = startPos.y + dy;

      if (gridSize > 0) {
        newX = Math.round(newX / gridSize) * gridSize;
        newY = Math.round(newY / gridSize) * gridSize;
      }

      newPositions.set(id, { x: newX, y: newY });
    }

    // Smart guides: snap the primary dragged tile, then offset others by the same delta.
    // Holding Shift disables guides for the duration of the drag (V1.0 plan §2.3).
    if (canvasStore.snapEnabled && gridSize === 0 && !e.shiftKey) {
      // Skip re-evaluation when the raw input delta hasn't moved enough since
      // the last evaluation to change snap targets — but still apply the
      // cached snap offset so previously-snapped tiles stay snapped.
      const deltaThreshold = 2 / canvasStore.scale;
      const skipEval = !Number.isNaN(lastGuideEvalDx)
        && Math.abs(dx - lastGuideEvalDx) < deltaThreshold
        && Math.abs(dy - lastGuideEvalDy) < deltaThreshold;

      if (skipEval) {
        if (lastSnapDx !== 0 || lastSnapDy !== 0) {
          for (const [id, pos] of newPositions) {
            newPositions.set(id, { x: pos.x + lastSnapDx, y: pos.y + lastSnapDy });
          }
        }
      } else {
        lastGuideEvalDx = dx;
        lastGuideEvalDy = dy;

        const primaryTile = boardStore.getTile(currentOptions.tileId);
        const primaryPos = newPositions.get(currentOptions.tileId);
        if (primaryTile && primaryPos) {
          const draggedBounds: TileBounds = {
            id: currentOptions.tileId,
            x: primaryPos.x,
            y: primaryPos.y,
            width: primaryTile.size.width,
            height: primaryTile.size.height,
          };

          // Query the rbush index over an expanded viewport so we only test
          // nearby tiles — much cheaper than iterating every tile on the board.
          const vp = canvasStore.viewportRect;
          const margin = 200 / canvasStore.scale;
          const candidateIds = spatialStore.queryViewport({
            left: vp.left - margin,
            top: vp.top - margin,
            right: vp.right + margin,
            bottom: vp.bottom + margin,
          });

          const otherTiles: TileBounds[] = [];
          for (const id of candidateIds) {
            if (startPositions.has(id)) continue;
            const t = boardStore.getTile(id);
            if (!t) continue;
            otherTiles.push({ id: t.id, x: t.position.x, y: t.position.y, width: t.size.width, height: t.size.height });
          }

          // Sprint B / B7 — cap the candidate set so dense boards don't melt
          // `computeGuides` per frame. See `capCandidatesByDistance` for the
          // sort criterion.
          capCandidatesByDistance(draggedBounds, otherTiles, SMART_GUIDE_MAX_CANDIDATES);

          const result = computeGuides(draggedBounds, otherTiles, 8 / canvasStore.scale);
          guidesStore.setGuides(result.guides);

          // Apply snap offset to all dragged tiles
          const snapDx = result.snapX !== null ? result.snapX - primaryPos.x : 0;
          const snapDy = result.snapY !== null ? result.snapY - primaryPos.y : 0;
          lastSnapDx = snapDx;
          lastSnapDy = snapDy;
          if (snapDx !== 0 || snapDy !== 0) {
            for (const [id, pos] of newPositions) {
              newPositions.set(id, { x: pos.x + snapDx, y: pos.y + snapDy });
            }
          }
        }
      }
    } else if (e.shiftKey) {
      // Shift held — clear any stale guides from prior moves
      guidesStore.clear();
      lastSnapDx = 0;
      lastSnapDy = 0;
    }

    for (const [id, pos] of newPositions) {
      boardStore.updateTile(id, {
        position: { x: pos.x, y: pos.y },
      });
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!isDragging) return;

    // Flush any queued frame against the latest event so the final cursor
    // position is committed before we snapshot history.
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      if (pendingEvent) {
        runMoveBody(pendingEvent);
        pendingEvent = null;
      }
    }

    isDragging = false;

    // Create a MoveTilesCommand for undo/redo if tiles actually moved
    if (hasMoved && startPositions.size > 0) {
      const positions = new Map<string, { before: { x: number; y: number }; after: { x: number; y: number } }>();
      for (const [id, before] of startPositions) {
        const tile = boardStore.getTile(id);
        if (tile) {
          const after = { x: tile.position.x, y: tile.position.y };
          // Only record if position actually changed
          if (before.x !== after.x || before.y !== after.y) {
            positions.set(id, { before, after });
          }
        }
      }
      if (positions.size > 0) {
        // Push to history without re-executing (tiles are already in their final positions)
        const cmd = new MoveTilesCommand(positions);
        // We use a raw push since execute() would move tiles again
        historyStore.pushWithoutExecute(cmd);

        // Re-evaluate frame membership for each moved tile (drag-in / drag-out).
        for (const id of positions.keys()) {
          framesStore.syncTileMembership(id);
        }
      }
    }

    startPositions.clear();
    node.releasePointerCapture(e.pointerId);
    activePointerId = null;
    document.body.style.cursor = '';
    stopEdgePan();
    guidesStore.clear();
    spatialStore.endBatch();
    window.removeEventListener('keydown', onWindowKeyDown, true);
  }

  function onPointerCancel(_e: PointerEvent) {
    if (!isDragging) return;
    // D.4 — native pointercancel (OS gesture steals the pointer, browser
    // fullscreen, etc.) routes through the same snap-back path as Escape so
    // the user doesn't end up with a tile stranded mid-drag with no way to
    // revert. cancelDrag handles capture release, rAF cleanup, edge-pan
    // stop, guides clear, and the keydown listener teardown.
    cancelDrag();
  }

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerUp);
  node.addEventListener('pointercancel', onPointerCancel);

  return {
    update(newOptions: TileDragOptions) {
      currentOptions = newOptions;
    },
    destroy() {
      // Sprint B / B3 — if the tile unmounts mid-drag, restore each captured
      // start position (cancel-not-commit) and NEVER push a MoveTilesCommand.
      // A half-committed move would corrupt undo: the user couldn't reach
      // the pre-drag state without the snapshot, and the post-drag state is
      // wherever the cursor happened to be at unmount — almost certainly
      // not what the user wanted.
      const wasDragging = isDragging;
      isDragging = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingEvent = null;
      if (wasDragging) {
        for (const [id, startPos] of startPositions) {
          if (boardStore.getTile(id)) {
            boardStore.updateTile(id, { position: { x: startPos.x, y: startPos.y } });
          }
        }
      }
      startPositions.clear();
      activePointerId = null;
      document.body.style.cursor = '';
      stopEdgePan();
      if (wasDragging) {
        guidesStore.clear();
        spatialStore.endBatch();
      }
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onWindowKeyDown, true);
    },
  };
}
