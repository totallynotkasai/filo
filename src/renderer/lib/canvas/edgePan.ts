import type { CanvasScope } from '../../stores/canvas.svelte';
import { CANVAS_DEFAULTS } from '../../constants/defaults';

/**
 * Edge-pan action — auto-pans the canvas when a drag operation
 * reaches the screen edge. Attach to the canvas container.
 *
 * Usage: <div use:edgePanAction>...</div>
 *
 * Call edgePanAction.start() when a drag begins and edgePanAction.stop() when it ends.
 */

interface EdgePanState {
  active: boolean;
  rafId: number | null;
  mouseX: number;
  mouseY: number;
  // Audit 5.4 — the canvas scope captured at start time. Edge-pan is a
  // module singleton; routing through the global `canvasStore` facade made
  // tick() pan whichever pane was active AT TICK TIME. Connection drawing
  // doesn't use pointer capture, so activating another pane mid-draw made
  // edge-pan scroll the wrong pane's canvas (and persist its viewport).
  // Pinning the originating pane's scope keeps the pan on the right canvas.
  scope: CanvasScope | null;
}

const state: EdgePanState = {
  active: false,
  rafId: null,
  mouseX: 0,
  mouseY: 0,
  scope: null,
};

function tick() {
  if (!state.active) return;
  const scope = state.scope;
  if (!scope) return;

  const margin = CANVAS_DEFAULTS.edgePanMargin;
  const speed = CANVAS_DEFAULTS.edgePanSpeed;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let dx = 0;
  let dy = 0;

  if (state.mouseX < margin) {
    dx = speed * ((margin - state.mouseX) / margin);
  } else if (state.mouseX > vw - margin) {
    dx = -speed * ((state.mouseX - (vw - margin)) / margin);
  }

  if (state.mouseY < margin) {
    dy = speed * ((margin - state.mouseY) / margin);
  } else if (state.mouseY > vh - margin) {
    dy = -speed * ((state.mouseY - (vh - margin)) / margin);
  }

  if (dx !== 0 || dy !== 0) {
    scope.panBy(dx, dy);
  }

  state.rafId = requestAnimationFrame(tick);
}

/**
 * Starts edge-panning. Call when a drag operation begins, passing the
 * pane-local canvas scope that should be panned for the duration of the
 * gesture. (Tile drag is pointer-captured to the active pane, so it can
 * pass the global facade; connection drawing must pass its own pane's
 * scope because it has no pointer capture — see Audit 5.4.)
 */
export function startEdgePan(scope: CanvasScope): void {
  if (state.active) return;
  state.active = true;
  state.scope = scope;
  state.rafId = requestAnimationFrame(tick);
}

/**
 * Stops edge-panning. Call when a drag operation ends.
 */
export function stopEdgePan(): void {
  state.active = false;
  state.scope = null;
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

/**
 * Updates the current pointer position for edge detection.
 * Call on every pointermove during a drag.
 */
export function updateEdgePanMouse(x: number, y: number): void {
  state.mouseX = x;
  state.mouseY = y;
}

/**
 * Test/introspection accessor — the canvas scope currently driving edge-pan
 * (pinned at start time), or null when idle.
 */
export function getEdgePanScope(): CanvasScope | null {
  return state.scope;
}

/**
 * Sync edge-pan with connection-drawing state for ONE pane's effect.
 *
 * Connection-drawing state (`connectionsStore.drawing`) is GLOBAL, so in a
 * split view BOTH mounted MindMapBoards' edge-pan effects fire on its
 * transition. Edge-pan is a module singleton armed first-caller-wins
 * (`startEdgePan` early-returns when already active), so the first-mounted pane
 * could pin ITS scope even when the user is drawing in the OTHER pane —
 * edge-pan would then scroll the wrong canvas (Audit 5.2; the earlier Audit-5.4
 * fix pinned a scope but not necessarily the right pane's).
 *
 * Gate on the active pane: a connection draw starts with a pointerdown in its
 * pane, and PaneView's capture-phase handler activates that pane before drawing
 * begins, so the drawing pane is always the active one. An inactive pane must
 * NOT touch the singleton (neither arm nor stop) or it would pin the wrong
 * scope / cancel the active pane's pan.
 */
export function syncConnectionEdgePan(
  scope: CanvasScope,
  isDrawing: boolean,
  isActivePane: boolean,
): void {
  if (!isActivePane) return;
  if (isDrawing) startEdgePan(scope);
  else stopEdgePan();
}

/**
 * Svelte action for edge-panning. Tracks mouse position when active.
 */
export function edgePanAction(node: HTMLElement) {
  function onPointerMove(e: PointerEvent) {
    if (state.active) {
      state.mouseX = e.clientX;
      state.mouseY = e.clientY;
    }
  }

  node.addEventListener('pointermove', onPointerMove);

  return {
    destroy() {
      stopEdgePan();
      node.removeEventListener('pointermove', onPointerMove);
    },
  };
}
