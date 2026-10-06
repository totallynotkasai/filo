import type { CanvasScope } from '../../stores/canvas.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { sidebarCoverRight } from '../utils/sidebarLayout';
import { viewRect, withoutCoveredLeft, type PlacedRect } from './newTilePlacement';

/**
 * The part of a pane's canvas a new tile or frame should go in: its view,
 * less what the vault sidebar covers. In a wide window the docked sidebar
 * lies over the canvas's left edge, so the middle of the whole view is off
 * to the left of what the user sees, and a tile stepped left of it could
 * start under the sidebar, its title edit with it.
 */
export function newTileView(canvas: Pick<CanvasScope, 'viewportRect' | 'viewportScreenLeft' | 'scale'>): PlacedRect {
  const coverRight = sidebarCoverRight({
    open: uiStore.sidebarOpen,
    floating: uiStore.sidebarFloating,
    pushes: uiStore.sidebarPushesWorkspace,
    width: uiStore.sidebarWidth,
    floatingBounds: uiStore.floatingBounds,
    windowWidth: window.innerWidth,
  });
  return withoutCoveredLeft(viewRect(canvas.viewportRect), coverRight - canvas.viewportScreenLeft, canvas.scale);
}
