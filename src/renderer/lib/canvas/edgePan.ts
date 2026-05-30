import { canvasStore } from '../../stores/canvas.svelte';
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
}

const state: EdgePanState = {
  active: false,
  rafId: null,
  mouseX: 0,
  mouseY: 0,
};

function tick() {
  if (!state.active) return;

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
    canvasStore.panBy(dx, dy);
  }

  state.rafId = requestAnimationFrame(tick);
}

/**
 * Starts edge-panning. Call when a drag operation begins.
 */
export function startEdgePan(): void {
  if (state.active) return;
  state.active = true;
  state.rafId = requestAnimationFrame(tick);
}

/**
 * Stops edge-panning. Call when a drag operation ends.
 */
export function stopEdgePan(): void {
  state.active = false;
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
