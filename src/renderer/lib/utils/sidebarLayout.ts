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
