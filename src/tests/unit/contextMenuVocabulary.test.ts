import { describe, it, expect, vi } from 'vitest';
import { countOf, lockLabel, selectedHeading, MENU_LABEL } from '@renderer/constants/menuVocabulary';
import {
  buildBulkCardContextMenu,
  buildCardContextMenu,
  buildColumnContextMenu,
} from '@renderer/lib/kanban/kanbanContextMenus';
import {
  buildRemoveWithSubtasksMenu,
  buildSectionContextMenu,
  buildTaskContextMenu,
} from '@renderer/lib/tasklist/taskContextMenus';
import { buildSidebarFileMenu } from '@renderer/lib/vault/sidebarFileMenu';
import type { ContextMenuItem } from '@renderer/stores/ui.svelte';

/**
 * Every board's menus and the sidebar's use one vocabulary: "Remove from
 * board" keeps the file, "Delete from vault…" moves it to Filo's trash, and
 * the shared items come in the order Open, Style, Tags, Lock, Remove, Delete.
 */

const noop = (): void => {};
const SHARED_ORDER: string[] = [
  MENU_LABEL.openAsDocument, MENU_LABEL.style, MENU_LABEL.tags,
  MENU_LABEL.lock, MENU_LABEL.unlock, MENU_LABEL.removeFromBoard, MENU_LABEL.deleteFromVault,
];

function labels(items: ContextMenuItem[]): string[] {
  return items.filter((i) => !i.divider).map((i) => i.label);
}

function inSharedOrder(items: ContextMenuItem[]): boolean {
  const idx = labels(items).filter((l) => SHARED_ORDER.includes(l)).map((l) => SHARED_ORDER.indexOf(l));
  return idx.every((v, i) => i === 0 || v > (idx[i - 1] ?? -1));
}

describe('menu vocabulary helpers', () => {
  it('pluralises counts and headings', () => {
    expect(countOf(1, 'card')).toBe('1 card');
    expect(countOf(3, 'card')).toBe('3 cards');
    expect(selectedHeading(1, 'card')).toBe('1 card selected');
    expect(selectedHeading(3, 'card')).toBe('3 cards selected');
    expect(selectedHeading(2, 'tile')).toBe('2 tiles selected');
  });

  it('follows the Ctrl+L rule for Lock / Unlock', () => {
    expect(lockLabel(true)).toBe('Lock');
    expect(lockLabel(false)).toBe('Unlock');
  });
});

describe('Kanban menus', () => {
  it('card: Open as document, Style…, Remove from board', () => {
    const open = vi.fn();
    const remove = vi.fn();
    const items = buildCardContextMenu({ onOpenAsDocument: open, onStyle: noop, onRemove: remove });
    expect(labels(items)).toEqual(['Open as document', 'Style…', 'Remove from board']);
    expect(inSharedOrder(items)).toBe(true);
    items.find((i) => i.id === 'open-as-document')?.action?.();
    items.find((i) => i.id === 'remove')?.action?.();
    expect(open).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('card with no note has no Open', () => {
    expect(labels(buildCardContextMenu({ onStyle: noop, onRemove: noop }))).toEqual(['Style…', 'Remove from board']);
  });

  it('card: Move to column before the danger items, then Delete from vault… as on a task', () => {
    const del = vi.fn();
    const items = buildCardContextMenu({
      onOpenAsDocument: noop, onStyle: noop, onRemove: noop, onDeleteFromVault: del,
      moveTargets: [{ id: 'b', title: 'Done' }], onMoveTo: noop,
    });
    expect(labels(items)).toEqual(['Open as document', 'Style…', 'Move to column', 'Done', 'Remove from board', 'Delete from vault…']);
    expect(items.filter((i) => i.danger).map((i) => i.label)).toEqual(['Remove from board', 'Delete from vault…']);
    items.find((i) => i.id === 'delete-from-vault')?.action?.();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('bulk: a real heading with the plural count, then the move targets under their own heading', () => {
    const move = vi.fn();
    const items = buildBulkCardContextMenu({
      count: 3,
      columns: [{ id: 'a', title: 'Todo' }, { id: 'b', title: 'Done' }],
      onAddTag: noop, onRemove: noop, onMoveTo: move,
    });
    expect(labels(items)).toEqual(['3 cards selected', 'Add tag…', 'Move to column', 'Todo', 'Done', 'Remove from board']);
    expect(items.filter((i) => i.heading).map((i) => i.label)).toEqual(['3 cards selected', 'Move to column']);
    // Headings are headings, not disabled pseudo-items.
    expect(items.some((i) => i.disabled)).toBe(false);
    items.find((i) => i.id === 'move-to-b')?.action?.();
    expect(move).toHaveBeenCalledWith('b');
  });

  it('column: Style… and sentence-case labels', () => {
    const base = { onAddCard: noop, onRename: noop, onStyle: noop, onToggleCollapse: noop, onEditWip: noop, onDelete: noop };
    expect(labels(buildColumnContextMenu({ ...base, collapsed: false, wipLimit: null }))).toEqual([
      'Add card', 'Rename column', 'Style…', 'Collapse', 'Set WIP limit…', 'Delete column',
    ]);
    const withWip = labels(buildColumnContextMenu({ ...base, collapsed: true, wipLimit: 4 }));
    expect(withWip).toContain('WIP limit: 4…');
    expect(withWip).toContain('Expand');
  });
});

describe('Task List menus', () => {
  function taskMenu(over: Partial<Parameters<typeof buildTaskContextMenu>[0]> = {}): ContextMenuItem[] {
    return buildTaskContextMenu({
      completed: false,
      onOpenAsDocument: noop,
      onRename: noop,
      onAddSubtask: noop,
      onToggleComplete: noop,
      onCyclePriority: noop,
      onTags: noop,
      moveTargets: [{ id: 's2', title: 'Later' }],
      moveCount: 1,
      onMoveTo: noop,
      onRemove: noop,
      onDeleteFromVault: noop,
      ...over,
    });
  }

  it('task: shared items in the shared order, Remove then Delete from vault… last', () => {
    const items = taskMenu();
    expect(labels(items)).toEqual([
      'Open as document', 'Rename task', 'Add subtask', 'Mark complete', 'Cycle priority', 'Tags…',
      'Move to: Later', 'Remove from board', 'Delete from vault…',
    ]);
    expect(inSharedOrder(items)).toBe(true);
  });

  it('task: Remove keeps the file, Delete from vault… runs the trash flow', () => {
    const remove = vi.fn();
    const del = vi.fn();
    const items = taskMenu({ onRemove: remove, onDeleteFromVault: del });
    items.find((i) => i.id === 'remove')?.action?.();
    items.find((i) => i.id === 'delete-from-vault')?.action?.();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('task: counts a bulk move and leaves out what the row lacks', () => {
    const items = taskMenu({ moveCount: 3, onAddSubtask: undefined, onTags: undefined, onDeleteFromVault: undefined, completed: true });
    expect(labels(items)).toEqual([
      'Open as document', 'Rename task', 'Mark incomplete', 'Cycle priority', 'Move 3 tasks to: Later', 'Remove from board',
    ]);
  });

  it('section: Style… and wording that says tasks leave the board, not the vault', () => {
    const base = { onRename: noop, onStyle: noop, onMoveUp: noop, onMoveDown: noop, onDeleteKeepTasks: noop, onDeleteWithTasks: noop };
    expect(labels(buildSectionContextMenu({ ...base, isDefault: false }))).toEqual([
      'Rename section', 'Style…', 'Move up', 'Move down', 'Delete section, keep tasks', 'Delete section, remove its tasks from board',
    ]);
    expect(labels(buildSectionContextMenu({ ...base, isDefault: true }))).toEqual(['Rename section']);
  });

  it('removing a parent task says Remove, with correct plurals', () => {
    const one = buildRemoveWithSubtasksMenu({ childCount: 1, onRemoveAll: noop, onKeepSubtasks: noop });
    const many = buildRemoveWithSubtasksMenu({ childCount: 2, onRemoveAll: noop, onKeepSubtasks: noop });
    expect(labels(one)).toEqual(['Remove task and 1 subtask from board', 'Remove task, keep subtasks as top-level', 'Cancel']);
    expect(labels(many)[0]).toBe('Remove task and 2 subtasks from board');
  });
});

describe('sidebar menu', () => {
  function sidebar(isDirectory: boolean, isNote: boolean): ContextMenuItem[] {
    return buildSidebarFileMenu({
      isDirectory, isNote,
      onTags: noop, onRename: noop, onRenameToTitle: noop, onReveal: noop, onDelete: noop,
    });
  }

  it('note: Tags… first, Delete from vault… last', () => {
    const items = sidebar(false, true);
    expect(labels(items)).toEqual([
      'Tags…', 'Rename', 'Rename file to match title', 'Reveal in File Explorer', 'Delete from vault…',
    ]);
    expect(inSharedOrder(items)).toBe(true);
  });

  it('folder: no tags, same Delete from vault…', () => {
    expect(labels(sidebar(true, false))).toEqual(['Rename', 'Reveal in File Explorer', 'Delete from vault…']);
  });
});
