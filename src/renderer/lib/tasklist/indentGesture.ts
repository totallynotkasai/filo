/**
 * Indent / outdent gesture classification for task drag.
 *
 * A horizontal drag on a task row is interpreted as a request to make the
 * dragged row a subtask of the row it lands on (rightward) or to clear its
 * parent so it floats up a level (leftward). Vertical drags reorder.
 *
 * The classifier is intentionally biased toward "reorder": horizontal motion
 * must dominate vertical motion by 1.5× *and* clear a 60px threshold before
 * it counts as indent. Sloppy diagonals stay reorders.
 *
 * Pure — no DOM, no Svelte. Unit-testable in isolation.
 */

/**
 * Horizontal threshold (px) before a drag is interpreted as indent/outdent
 * rather than a reorder. Tuned to feel intentional without being fiddly — a
 * sloppy horizontal slip during reorder stays a reorder.
 */
export const INDENT_THRESHOLD_PX = 60;

/**
 * Returns `true` when a drag delta represents an intentional horizontal
 * (indent/outdent) gesture rather than a vertical reorder. The caller adds
 * the directional clause (`deltaX > 0` for indent, `deltaX < 0` for outdent).
 */
export function isHorizontalIndentGesture(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaX) > Math.abs(deltaY) * 1.5
    && Math.abs(deltaX) > INDENT_THRESHOLD_PX;
}

/**
 * Classification a tracker returns to its consumer at drop time. `targetTileId`
 * is the row the cursor was hovering on the last pointermove tick (used as the
 * indent parent when `kind === 'indent'`).
 */
export interface IndentClassification {
  kind: 'indent' | 'outdent' | 'none';
  targetTileId: string | null;
}

/**
 * Pointer-geometry sidecar for the dndzone-driven drag. `svelte-dnd-action`
 * commits by drop *index*, not by pointer coordinates, so it can't tell an
 * indent gesture from a reorder on its own. The tracker captures the live
 * pointer position (and the `data-task-id` of the element under it) on every
 * pointermove so the finalize handler can ask "was that a horizontal shove?".
 *
 * The listener is installed with `{ capture: true, passive: true }` so it
 * fires *before* dnd-action's own window listener — important because we want
 * the last-known target to reflect the row under the cursor at drop time, not
 * a stale value snapshotted at a different phase of the event pipeline.
 *
 * Lifecycle is caller-driven: `install()` on dragstart, `uninstall()` on
 * drop or cancel. Re-installing without uninstalling first is a no-op.
 */
export interface IndentTracker {
  install(startX: number, startY: number): void;
  classify(): IndentClassification;
  uninstall(): void;
}

export function createIndentTracker(): IndentTracker {
  let installed = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastTargetTileId: string | null = null;

  const handler = (e: PointerEvent) => {
    lastX = e.clientX;
    lastY = e.clientY;
    // Walk up the DOM to find the nearest [data-task-id] — TaskItem.svelte
    // stamps this on every row's outer wrapper so a child node (checkbox
    // SVG, text span) still resolves to the owning row.
    let node = e.target as HTMLElement | null;
    while (node && !(node.dataset && node.dataset.taskId)) {
      node = node.parentElement;
    }
    lastTargetTileId = node?.dataset?.taskId ?? null;
  };

  return {
    install(sx: number, sy: number) {
      if (installed) return;
      startX = sx;
      startY = sy;
      lastX = sx;
      lastY = sy;
      lastTargetTileId = null;
      window.addEventListener('pointermove', handler, { capture: true, passive: true });
      installed = true;
    },
    classify(): IndentClassification {
      const dx = lastX - startX;
      const dy = lastY - startY;
      if (!isHorizontalIndentGesture(dx, dy)) {
        return { kind: 'none', targetTileId: lastTargetTileId };
      }
      return { kind: dx > 0 ? 'indent' : 'outdent', targetTileId: lastTargetTileId };
    },
    uninstall() {
      if (!installed) return;
      window.removeEventListener('pointermove', handler, { capture: true });
      installed = false;
      lastTargetTileId = null;
    },
  };
}
