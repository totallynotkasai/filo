import type { ContextMenuItem } from '../../stores/ui.svelte';
import type { Frame, Tile } from '../../schema/index';
import { STYLE_ICON_PATH } from '../../constants/icons';
import { MENU_ICON, MENU_LABEL, lockLabel, selectedHeading } from '../../constants/menuVocabulary';

interface BuildTileMenuOpts {
  selectedCount: number;
  /** Ctrl+L's rule over the selection: Lock when any tile is unlocked. */
  anyUnlocked: boolean;
  /** Present for one note-backed text tile; opens its note in a Document tab. */
  onOpenAsDocument?: () => void;
  onStyle: () => void;
  onTags: () => void;
  onSaveTemplate: () => void;
  onToggleLock: () => void;
  onRemove: () => void;
}

/**
 * The tile menu. Every action but Open applies to the whole selection (the
 * right-clicked tile is always part of it), so with several tiles selected a
 * heading names the count and Open, which acts on one note, is left out.
 */
export function buildTileContextMenu(opts: BuildTileMenuOpts): ContextMenuItem[] {
  const several = opts.selectedCount > 1;
  const items: ContextMenuItem[] = [];
  if (several) {
    items.push({ id: 'selection-heading', label: selectedHeading(opts.selectedCount, 'tile'), heading: true });
  } else if (opts.onOpenAsDocument) {
    items.push(
      { id: 'open-as-document', label: MENU_LABEL.openAsDocument, icon: MENU_ICON.openAsDocument, action: opts.onOpenAsDocument },
      { id: 'div-open', label: '', divider: true },
    );
  }
  items.push(
    { id: 'style', label: MENU_LABEL.style, icon: STYLE_ICON_PATH, action: opts.onStyle },
    { id: 'tags', label: MENU_LABEL.tags, icon: MENU_ICON.tags, action: opts.onTags },
    {
      id: 'lock',
      label: lockLabel(opts.anyUnlocked),
      icon: MENU_ICON.lock,
      shortcut: 'Ctrl+L',
      action: opts.onToggleLock,
    },
    { id: 'div1', label: '', divider: true },
    {
      id: 'save-template',
      label: 'Save as template…',
      icon: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
      action: opts.onSaveTemplate,
    },
    { id: 'div2', label: '', divider: true },
    {
      id: 'remove',
      label: MENU_LABEL.removeFromBoard,
      icon: MENU_ICON.remove,
      shortcut: 'Delete',
      danger: true,
      action: opts.onRemove,
    },
  );
  return items;
}

interface BuildFrameMenuOpts {
  frame: Frame;
  onStyle: () => void;
  onToggleCollapse: () => void;
  onSelectAll: () => void;
  onRemove: () => void;
}

export function buildFrameContextMenu(opts: BuildFrameMenuOpts): ContextMenuItem[] {
  const { frame } = opts;
  return [
    {
      id: 'style',
      label: MENU_LABEL.style,
      icon: STYLE_ICON_PATH,
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
      label: 'Select all in frame',
      icon: 'M3 3h18v18H3z',
      action: opts.onSelectAll,
    },
    { id: 'div2', label: '', divider: true },
    {
      // The frame goes; the tiles inside it stay on the board.
      id: 'remove',
      label: 'Remove frame',
      icon: MENU_ICON.remove,
      danger: true,
      action: opts.onRemove,
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
  onRemove: () => void;
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
  return [
    { id: 'selection-heading', label: selectedHeading(sel.count, 'tile'), heading: true },
    { id: 'selection-style', label: MENU_LABEL.style, icon: STYLE_ICON_PATH, action: sel.onStyle },
    { id: 'selection-tags', label: MENU_LABEL.tags, icon: MENU_ICON.tags, action: sel.onTags },
    {
      id: 'selection-lock',
      label: lockLabel(sel.anyUnlocked),
      icon: MENU_ICON.lock,
      shortcut: 'Ctrl+L',
      action: sel.onToggleLock,
    },
    {
      id: 'selection-remove',
      label: MENU_LABEL.removeFromBoard,
      icon: MENU_ICON.remove,
      shortcut: 'Delete',
      danger: true,
      action: sel.onRemove,
    },
    { id: 'selection-div', label: '', divider: true },
  ];
}

export function buildCanvasContextMenu(opts: BuildCanvasMenuOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    ...(opts.selection && opts.selection.count > 1 ? buildSelectionGroup(opts.selection) : []),
    {
      id: 'new-tile',
      label: 'New tile',
      icon: 'M12 5v14M5 12h14',
      shortcut: 'Ctrl+N',
      action: opts.onNewTile,
    },
    {
      id: 'new-frame',
      label: 'New frame',
      icon: 'M3 3h18v18H3zM3 9h18M3 15h18',
      action: opts.onNewFrame,
    },
    {
      id: 'insert-template',
      label: 'Insert template…',
      icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
      shortcut: 'Ctrl+T',
      action: opts.onInsertTemplate,
    },
    {
      id: 'waypoint',
      label: 'Save as waypoint',
      icon: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z',
      action: opts.onSaveWaypoint,
    },
    { id: 'div1', label: '', divider: true },
    {
      id: 'select-all',
      label: 'Select all',
      icon: 'M3 3h18v18H3z',
      shortcut: 'Ctrl+A',
      action: opts.onSelectAll,
    },
    {
      id: 'orphan-catcher',
      label: 'Orphan Catcher…',
      icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4M12 16h.01',
      action: opts.onOrphanCatcher,
    },
  ];

  if (opts.brokenCount > 0 && opts.onRemoveBroken) {
    items.push({
      // Broken tiles have no file left, so this only drops their placements.
      id: 'remove-broken',
      label: `Remove broken tiles from board (${opts.brokenCount})`,
      icon: MENU_ICON.remove,
      danger: true,
      action: opts.onRemoveBroken,
    });
  }

  return items;
}

/** Re-export shape exposed by the orchestrator's local Tile/Frame proxies. */
export type { Tile, Frame, ContextMenuItem };
