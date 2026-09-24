import { boardStore } from './board.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';

/**
 * Connections store — manages transient connection UI state (connection mode,
 * drawing state). The persistent "hide all paths" / "hide all labels" /
 * "hide waypoints" flags are board-level settings; getters proxy to the
 * active board so the values persist across reloads, and toggles dispatch
 * through `boardStore.updateSettings`.
 */

let connectionModeActive = $state(false);
let drawingConnection = $state<DrawingConnection | null>(null);

export interface DrawingConnection {
  fromTileId: string;
  fromBubble: number;
  /** Current mouse position in canvas coords while drawing */
  currentX: number;
  currentY: number;
}

function getMindMapFlag(key: 'connectionsVisible' | 'labelsVisible' | 'waypointsVisible'): boolean {
  const s = boardStore.settings as Record<string, unknown> | null;
  if (!s || typeof s[key] !== 'boolean') return true;
  return s[key] as boolean;
}

export const connectionsStore = {
  get connectionMode() { return connectionModeActive; },
  get drawing() { return drawingConnection; },

  /** True when all connection paths are hidden at the board level. */
  get hideAllPaths() { return !getMindMapFlag('connectionsVisible'); },
  /** True when all connection labels are hidden at the board level. */
  get hideAllLabels() { return !getMindMapFlag('labelsVisible'); },

  toggleConnectionMode() {
    connectionModeActive = !connectionModeActive;
    if (!connectionModeActive) {
      drawingConnection = null;
    }
  },

  setConnectionMode(active: boolean) {
    connectionModeActive = active;
    if (!active) {
      drawingConnection = null;
    }
  },

  startDrawing(fromTileId: string, fromBubble: number, x: number, y: number) {
    drawingConnection = { fromTileId, fromBubble, currentX: x, currentY: y };
  },

  updateDrawing(x: number, y: number) {
    if (drawingConnection) {
      drawingConnection = { ...drawingConnection, currentX: x, currentY: y };
    }
  },

  cancelDrawing() {
    drawingConnection = null;
  },

  finishDrawing() {
    drawingConnection = null;
  },

  toggleHidePaths() {
    const prevVisible = getMindMapFlag('connectionsVisible');
    boardStore.updateBoardSettingsWithHistory(
      { connectionsVisible: !prevVisible },
      boardStore.settings ?? {},
      prevVisible ? 'Hide connections' : 'Show connections',
    );
  },

  toggleHideLabels() {
    const prevVisible = getMindMapFlag('labelsVisible');
    boardStore.updateBoardSettingsWithHistory(
      { labelsVisible: !prevVisible },
      boardStore.settings ?? {},
      prevVisible ? 'Hide connection labels' : 'Show connection labels',
    );
  },

};

// Drop transient connection UI state on vault swap so the
// new vault doesn't open with the prior vault's "connection-drawing in
// progress" pointer-tracking pinned to a tile id that no longer exists.
onVaultSwap('pre-swap', 'connections', () => {
  connectionModeActive = false;
  drawingConnection = null;
});
