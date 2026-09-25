import type { ContextMenuItem } from '../../stores/ui.svelte';
import type { Frame, Tile } from '../../schema/index';

const STYLE_ICON = 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z';
const TAGS_ICON = 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01';
const LOCK_ICON = 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4';
const DELETE_ICON = 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2';

/** " (N tiles)" when more than one tile is affected, else nothing. */
function countSuffix(count: number): string {
  return count > 1 ? ` (${count} tiles)` : '';
}

interface BuildTileMenuOpts {
  selectedCount: number;
  hasBrokenTiles: boolean;
  brokenCount: number;
  onStyle: () => void;
  onTags: () => void;
  onSaveTemplate: () => void;
  onToggleLock: () => void;
  onDelete: () => void;
}

/**
 * The tile menu. Every action applies to the whole selection (the right-clicked
 * tile is always part of it), so each label carries the count when it's
 * more than one.
 */
export function buildTileContextMenu(opts: BuildTileMenuOpts): ContextMenuItem[] {
  const suffix = countSuffix(opts.selectedCount);

  return [
    {
      id: 'style',
      label: `Style${suffix}`,
      icon: STYLE_ICON,
      action: opts.onStyle,
    },
    {
      id: 'tags',
      label: `Tags${suffix}`,
      icon: TAGS_ICON,
      action: opts.onTags,
    },
    { id: 'div1', label: '', divider: true },
    {
      id: 'save-template',
      label: 'Save as Template',
      icon: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
      action: opts.onSaveTemplate,
    },
    {
      id: 'lock',
      label: `Lock / Unlock${suffix}`,
      icon: LOCK_ICON,
      shortcut: 'Ctrl+L',
      action: opts.onToggleLock,
    },
    { id: 'div2', label: '', divider: true },
    {
      id: 'delete',
      label: `Delete${suffix}`,
      icon: DELETE_ICON,
      shortcut: 'Delete',
      danger: true,
      action: opts.onDelete,
    },
  ];
}

interface BuildFrameMenuOpts {
  frame: Frame;
  onStyle: () => void;
  onToggleCollapse: () => void;
  onSelectAll: () => void;
  onDelete: () => void;
}

export function buildFrameContextMenu(opts: BuildFrameMenuOpts): ContextMenuItem[] {
  const { frame } = opts;
  return [
    {
      id: 'style',
      label: 'Style',
      icon: STYLE_ICON,
      action: opts.onStyle,
    },
    {
      id: 'collapse',
      label: frame.collapsed ? 'Expand' : 'Collapse',
      icon: frame.collapsed ? 'M9 18l6-6-6-6' : 'M6 9l6 6 6-6',
      action: opts.onToggleCollapse,
    },
    { id: 'div1', label: '', divider: true },
    {
      id: 'select-all-in-frame',
      label: 'Select All in Frame',
      icon: 'M3 3h18v18H3z',
      action: opts.onSelectAll,
    },
    { id: 'div2', label: '', divider: true },
    {
      id: 'delete',
      label: 'Delete Frame',
      icon: DELETE_ICON,
      danger: true,
      action: opts.onDelete,
    },
  ];
}

/**
 * Actions on the current selection, offered on empty canvas when two or more
 * tiles are selected. Each applies to every selected tile.
 */
export interface CanvasSelectionActions {
  count: number;
  /** Ctrl+L's rule: lock all if any is unlocked, else unlock all. */
  anyUnlocked: boolean;
  onToggleLock: () => void;
  onTags: () => void;
  onStyle: () => void;
  onDelete: () => void;
}

interface BuildCanvasMenuOpts {
  /** Present only when two or more tiles are selected. */
  selection?: CanvasSelectionActions;
  brokenCount: number;
  onNewTile: () => void;
  onNewFrame: () => void;
  onInsertTemplate: () => void;
  onSaveWaypoint: () => void;
  onSelectAll: () => void;
  onOrphanCatcher: () => void;
  onRemoveBroken?: () => void;
}

function buildSelectionGroup(sel: CanvasSelectionActions): ContextMenuItem[] {
  const n = ` (${sel.count} tiles)`;
  return [
    { id: 'selection-heading', label: `${sel.count} tiles selected`, heading: true },
    {
      id: 'selection-lock',
      label: `${sel.anyUnlocked ? 'Lock' : 'Unlock'}${n}`,
      icon: LOCK_ICON,
      shortcut: 'Ctrl+L',
      action: sel.onToggleLock,
    },
    { id: 'selection-tags', label: `Tags${n}`, icon: TAGS_ICON, action: sel.onTags },
    { id: 'selection-style', label: `Style${n}`, icon: STYLE_ICON, action: sel.onStyle },
    {
      id: 'selection-delete',
      label: `Delete${n}`,
      icon: DELETE_ICON,
      shortcut: 'Delete',
      danger: true,
      action: sel.onDelete,
    },
    { id: 'selection-div', label: '', divider: true },
  ];
}

export function buildCanvasContextMenu(opts: BuildCanvasMenuOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    ...(opts.selection && opts.selection.count > 1 ? buildSelectionGroup(opts.selection) : []),
    {
      id: 'new-tile',
      label: 'New Tile',
      icon: 'M12 5v14M5 12h14',
      shortcut: 'Ctrl+N',
      action: opts.onNewTile,
    },
    {
      id: 'new-frame',
      label: 'New Frame',
      icon: 'M3 3h18v18H3zM3 9h18M3 15h18',
      action: opts.onNewFrame,
    },
    {
      id: 'insert-template',
      label: 'Insert Template',
      icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
      shortcut: 'Ctrl+T',
      action: opts.onInsertTemplate,
    },
    {
      id: 'waypoint',
      label: 'Save as Waypoint',
      icon: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z',
      action: opts.onSaveWaypoint,
    },
    { id: 'div1', label: '', divider: true },
    {
      id: 'select-all',
      label: 'Select All',
      icon: 'M3 3h18v18H3z',
      shortcut: 'Ctrl+A',
      action: opts.onSelectAll,
    },
    {
      id: 'orphan-catcher',
      label: 'Orphan Catcher',
      icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4M12 16h.01',
      action: opts.onOrphanCatcher,
    },
  ];

  if (opts.brokenCount > 0 && opts.onRemoveBroken) {
    items.push({
      id: 'remove-broken',
      label: `Remove Broken Tiles (${opts.brokenCount})`,
      icon: DELETE_ICON,
      danger: true,
      action: opts.onRemoveBroken,
    });
  }

  return items;
}

/** Re-export shape exposed by the orchestrator's local Tile/Frame proxies. */
export type { Tile, Frame, ContextMenuItem };
