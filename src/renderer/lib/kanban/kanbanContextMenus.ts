import type { ContextMenuItem } from '../../stores/ui.svelte';
import { STYLE_ICON_PATH } from '../../constants/icons';
import { MENU_ICON, MENU_LABEL, selectedHeading } from '../../constants/menuVocabulary';

interface CardMenuOpts {
  /** Present for a note-backed card; opens its note in a Document tab. */
  onOpenAsDocument?: () => void;
  onStyle: () => void;
  /** Drops the card's placement; the note stays in the vault. */
  onRemove: () => void;
  /** The board's other columns: the card can move to any of them. */
  moveTargets?: ReadonlyArray<{ id: string; title: string }>;
  onMoveTo?: (columnId: string) => void;
}

/**
 * One card's menu. Tags and Lock live on the card's own header, so the menu
 * keeps to what the header doesn't offer. "Move to column" moves the card
 * without a drag (from the keyboard too: the menu key on a selected card).
 */
export function buildCardContextMenu(opts: CardMenuOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (opts.onOpenAsDocument) {
    items.push(
      { id: 'open-as-document', label: MENU_LABEL.openAsDocument, icon: MENU_ICON.openAsDocument, action: opts.onOpenAsDocument },
      { id: 'div', label: '', divider: true },
    );
  }
  items.push(
    { id: 'style', label: MENU_LABEL.style, icon: STYLE_ICON_PATH, action: opts.onStyle },
    { id: 'remove', label: MENU_LABEL.removeFromBoard, icon: MENU_ICON.remove, danger: true, action: opts.onRemove },
  );
  const onMoveTo = opts.onMoveTo;
  if (onMoveTo && opts.moveTargets && opts.moveTargets.length > 0) {
    items.push(
      { id: 'div-move', label: '', divider: true },
      { id: 'move-heading', label: 'Move to column', heading: true },
      ...opts.moveTargets.map((c) => ({ id: `move-to-${c.id}`, label: c.title, icon: MENU_ICON.moveTo, action: () => onMoveTo(c.id) })),
    );
  }
  return items;
}

interface ColumnMenuOpts {
  collapsed: boolean;
  /** The column's WIP limit when one is set. */
  wipLimit: number | null;
  onAddCard: () => void;
  onRename: () => void;
  onStyle: () => void;
  onToggleCollapse: () => void;
  onEditWip: () => void;
  onDelete: () => void;
}

export function buildColumnContextMenu(opts: ColumnMenuOpts): ContextMenuItem[] {
  return [
    { id: 'add-tile', label: 'Add card', icon: MENU_ICON.add, action: opts.onAddCard },
    { id: 'rename', label: 'Rename column', icon: MENU_ICON.rename, action: opts.onRename },
    { id: 'style', label: MENU_LABEL.style, icon: STYLE_ICON_PATH, action: opts.onStyle },
    {
      id: 'collapse',
      label: opts.collapsed ? 'Expand' : 'Collapse',
      icon: opts.collapsed ? 'M9 18l6-6-6-6' : 'M6 9l6 6 6-6',
      action: opts.onToggleCollapse,
    },
    {
      id: 'wip',
      label: opts.wipLimit !== null ? `WIP limit: ${opts.wipLimit}…` : 'Set WIP limit…',
      action: opts.onEditWip,
    },
    { id: 'div', label: '', divider: true },
    // A column is board structure, not a file; its cards stay in the vault.
    { id: 'delete', label: 'Delete column', icon: MENU_ICON.trash, danger: true, action: opts.onDelete },
  ];
}

interface BulkCardMenuOpts {
  count: number;
  columns: ReadonlyArray<{ id: string; title: string }>;
  /** Asks for one tag and adds it to every selected card. */
  onAddTag: () => void;
  onRemove: () => void;
  onMoveTo: (columnId: string) => void;
}

/** The menu on a card that is part of a selection of two or more. */
export function buildBulkCardContextMenu(opts: BulkCardMenuOpts): ContextMenuItem[] {
  return [
    { id: 'selection-heading', label: selectedHeading(opts.count, 'card'), heading: true },
    // Adds one tag rather than opening the tag editor, so it isn't "Tags…".
    { id: 'tag', label: 'Add tag…', icon: MENU_ICON.tags, action: opts.onAddTag },
    { id: 'remove', label: MENU_LABEL.removeFromBoard, icon: MENU_ICON.remove, danger: true, action: opts.onRemove },
    { id: 'div', label: '', divider: true },
    { id: 'move-heading', label: 'Move to column', heading: true },
    ...opts.columns.map((c) => ({
      id: `move-to-${c.id}`,
      label: c.title,
      icon: MENU_ICON.moveTo,
      action: () => opts.onMoveTo(c.id),
    })),
  ];
}
