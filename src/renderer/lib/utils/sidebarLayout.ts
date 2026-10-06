/**
 * The widest centred view: the Document page (860 px). The Task List
 * (800 px) and Kanban (which moves its columns clear itself) need less.
 */
const CENTRED_VIEW_PX = 860;

/**
 * Whether the docked sidebar pushes the workspace aside instead of lying
 * over its left edge.
 *
 * DECISION: over the workspace while a centred page still clears it, so the
 * boards keep the whole width (and the Task List's Table of Contents its room
 * beside the list); pushed once the window is narrower than the page plus the
 * sidebar on both sides (1,340 px with the default 240 px sidebar, more with
 * a wider one), where the sidebar would cover the start of every line.
 */
export function sidebarPushesWorkspace(windowWidth: number, sidebarWidth: number): boolean {
  return windowWidth < CENTRED_VIEW_PX + 2 * sidebarWidth;
}

interface SidebarPlace {
  open: boolean;
  floating: boolean;
  /** Whether the docked sidebar pushes the workspace aside (`sidebarPushesWorkspace`). */
  pushes: boolean;
  width: number;
  floatingBounds: { x: number; width: number };
  windowWidth: number;
}

/**
 * How far from the window's left edge the vault sidebar lies over the
 * workspace, in pixels; 0 when it covers nothing there. The docked sidebar
 * covers its width unless it pushes the workspace aside; the floating panel
 * counts only in the window's left half (as the Kanban columns' shift does),
 * since one dragged to the right covers no left edge.
 */
export function sidebarCoverRight(s: SidebarPlace): number {
  if (!s.open) return 0;
  if (s.floating) {
    if (s.floatingBounds.x >= s.windowWidth / 2) return 0;
    return Math.max(0, s.floatingBounds.x + s.floatingBounds.width);
  }
  return s.pushes ? 0 : s.width;
}
