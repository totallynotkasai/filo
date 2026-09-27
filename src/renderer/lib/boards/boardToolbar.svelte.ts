/**
 * A board's floating side toolbar: drag, pin and right-click reset, with the
 * resting position and pin kept per board in `.filo/workspace.json` (through
 * the workspace store). Shared by the Mind Map, Kanban and Task List toolbars.
 * Only the resting position is saved, never the positions a drag passes.
 */
import { workspaceStore } from '../../stores/workspace.svelte';
import {
  createFloatingToolbarDrag,
  floatingToolbarStyle,
  type FloatingToolbarDragHandlers,
  type ToolbarPosition,
} from '../canvas/floatingToolbarDrag';

export interface BoardToolbarController {
  readonly handlers: FloatingToolbarDragHandlers;
  readonly dragging: boolean;
  readonly pinned: boolean;
  /** Inline position style; '' while docked. */
  readonly style: string;
  togglePin(): void;
  /** Right-click on the background docks the toolbar again, unless it is pinned. */
  oncontextmenu(e: MouseEvent): void;
}

/**
 * `getBoardId` is read on every use, so a toolbar that stays mounted while its
 * scope switches boards follows the new board. `ignoreSelector` names the
 * buttons and menus a press on which never starts a drag.
 */
export function createBoardToolbar(getBoardId: () => string, ignoreSelector: string): BoardToolbarController {
  const toolbar = $derived(workspaceStore.boardToolbar(getBoardId()));
  let dragging = $state(false);
  let livePosition = $state<ToolbarPosition | null>(null);

  const handlers = createFloatingToolbarDrag({
    ignoreSelector,
    isPinned: () => toolbar.pinned,
    onStart: () => { dragging = true; },
    onMove: (p) => { livePosition = p; },
    onEnd: (p) => {
      dragging = false;
      livePosition = null;
      if (p) workspaceStore.setBoardToolbarPosition(getBoardId(), p);
    },
  });

  return {
    handlers,
    get dragging() { return dragging; },
    get pinned() { return toolbar.pinned; },
    get style() { return floatingToolbarStyle(livePosition ?? toolbar.position); },
    togglePin() {
      workspaceStore.setBoardToolbarPinned(getBoardId(), !toolbar.pinned);
    },
    oncontextmenu(e) {
      const target = e.target as Element | null;
      if (toolbar.pinned || target?.closest(ignoreSelector)) return;
      e.preventDefault();
      // The board's own context menu must not open over the reset.
      e.stopPropagation();
      workspaceStore.setBoardToolbarPosition(getBoardId(), null);
    },
  };
}
