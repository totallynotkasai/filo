import type { ContextMenuItem } from '../../stores/ui.svelte';
import { STYLE_ICON_PATH } from '../../constants/icons';
import { MENU_ICON, MENU_LABEL, copyLinkLabel } from '../../constants/menuVocabulary';

interface TaskMenuOpts {
  completed: boolean;
  onOpenAsDocument: () => void;
  /** Puts a link to the task on the clipboard. */
  onCopyLink?: () => void;
  onRename: () => void;
  /** Present when the task can take a subtask. */
  onAddSubtask?: () => void;
  onToggleComplete: () => void;
  onCyclePriority: () => void;
  onTags?: () => void;
  /** Sections the task can move to (its own left out). */
  moveTargets: ReadonlyArray<{ id: string; title: string }>;
  /** How many tasks a move carries: the selection when the row is part of one. */
  moveCount: number;
  onMoveTo: (sectionId: string) => void;
  /** Drops the task's placement; the note stays in the vault. */
  onRemove: () => void;
  /** Present when the task is a note: moves it to Filo's trash too. */
  onDeleteFromVault?: () => void;
}

export function buildTaskContextMenu(opts: TaskMenuOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { id: 'open', label: MENU_LABEL.openAsDocument, icon: MENU_ICON.openAsDocument, action: opts.onOpenAsDocument },
  ];
  if (opts.onCopyLink) items.push({ id: 'copy-link', label: copyLinkLabel('task'), icon: MENU_ICON.link, action: opts.onCopyLink });
  items.push({ id: 'edit', label: 'Rename task', icon: MENU_ICON.rename, action: opts.onRename });
  if (opts.onAddSubtask) {
    items.push({ id: 'add-subtask', label: 'New subtask', icon: MENU_ICON.add, action: opts.onAddSubtask });
  }
  items.push(
    { id: 'toggle', label: opts.completed ? 'Mark incomplete' : 'Mark complete', icon: 'M20 6L9 17l-5-5', action: opts.onToggleComplete },
    { id: 'priority', label: 'Cycle priority', icon: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3', action: opts.onCyclePriority },
  );
  if (opts.onTags) {
    items.push({ id: 'edit-tags', label: MENU_LABEL.tags, icon: MENU_ICON.tags, action: opts.onTags });
  }
  if (opts.moveTargets.length > 0) {
    items.push({ id: 'move-sep', label: '', divider: true });
    for (const s of opts.moveTargets) {
      items.push({
        id: `move-to-${s.id}`,
        label: opts.moveCount > 1 ? `Move ${opts.moveCount} tasks to: ${s.title}` : `Move to: ${s.title}`,
        icon: MENU_ICON.moveTo,
        action: () => opts.onMoveTo(s.id),
      });
    }
  }
  items.push(
    { id: 'div', label: '', divider: true },
    { id: 'remove', label: MENU_LABEL.removeFromBoard, icon: MENU_ICON.remove, danger: true, action: opts.onRemove },
  );
  if (opts.onDeleteFromVault) {
    items.push({ id: 'delete-from-vault', label: MENU_LABEL.deleteFromVault, icon: MENU_ICON.trash, danger: true, action: opts.onDeleteFromVault });
  }
  return items;
}

interface SectionMenuOpts {
  /** The built-in default section can only be renamed. */
  isDefault: boolean;
  onRename: () => void;
  onStyle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDeleteKeepTasks: () => void;
  onDeleteWithTasks: () => void;
}

export function buildSectionContextMenu(opts: SectionMenuOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { id: 'rename', label: 'Rename section', action: opts.onRename },
  ];
  if (opts.isDefault) return items;
  items.push(
    { id: 'style', label: MENU_LABEL.style, icon: STYLE_ICON_PATH, action: opts.onStyle },
    { id: 'move-up', label: 'Move up', action: opts.onMoveUp },
    { id: 'move-down', label: 'Move down', action: opts.onMoveDown },
    { id: 'div', label: '', divider: true },
    { id: 'delete-keep', label: 'Delete section, keep tasks', action: opts.onDeleteKeepTasks },
    // Its tasks leave the board; their notes stay in the vault.
    { id: 'delete-all', label: 'Delete section, remove its tasks from board', danger: true, action: opts.onDeleteWithTasks },
  );
  return items;
}

/** Offered when a removed task has subtasks. Neither choice touches a note file. */
export function buildRemoveWithSubtasksMenu(opts: {
  childCount: number;
  onRemoveAll: () => void;
  onKeepSubtasks: () => void;
}): ContextMenuItem[] {
  const n = opts.childCount;
  return [
    {
      id: 'delete-all',
      label: `Remove task and ${n} subtask${n === 1 ? '' : 's'} from board`,
      danger: true,
      action: opts.onRemoveAll,
    },
    { id: 'keep-subtasks', label: 'Remove task, keep subtasks as top-level', action: opts.onKeepSubtasks },
    { id: 'sep', label: '', divider: true },
    { id: 'cancel', label: 'Cancel', action: () => {} },
  ];
}
