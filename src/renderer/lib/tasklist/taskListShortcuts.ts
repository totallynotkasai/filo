/**
 * taskListShortcuts — a Task List's own shortcuts, registered while it is
 * mounted. Each has a command id, so it is listed in Help → Shortcuts and can
 * be rebound there.
 *
 * Every one acts only for the focused pane: a split view can mount two
 * boards sharing a key (`n` is also Kanban's and the Mind Map's). The bare N
 * acts only while focus is in the board as well (`focusIsInBoard`), so N
 * typed on a sidebar row or after a menu closed never jumps to quick add.
 * Ctrl+N is the Mind Map's New Tile; that command stands aside off the Mind
 * Map, so here it adds a task.
 */
import { registerCommandWithShortcut } from '../../core/commandRegistry';
import { TASK_LIST_SHORTCUTS } from '../../constants/shortcutReference';
import { focusIsInBoard } from '../utils/boardFocus';

export interface TaskListShortcutDeps {
  /** True while this board's pane is the active one. */
  isActivePane(): boolean;
  /** The board's root element. */
  boardRoot(): Element | null | undefined;
  focusQuickAdd(): void;
  selectAll(): void;
  /** A blank task, its title open for typing. */
  newTask(): void;
  /** Alt+Up / Alt+Down; false when the focused task can't move that way. */
  moveTask(direction: -1 | 1): boolean;
}

type TaskListCommandId = (typeof TASK_LIST_SHORTCUTS)[number]['id'];

/** Registers the board's shortcuts; the returned function removes them. */
export function registerTaskListShortcuts(deps: TaskListShortcutDeps): () => void {
  const ownsBareKeys = (): boolean => deps.isActivePane() && focusIsInBoard(deps.boardRoot());
  const run: Record<TaskListCommandId, { execute: () => void | boolean; enabled: () => boolean }> = {
    'tasklist:focus-quick-add': { execute: deps.focusQuickAdd, enabled: ownsBareKeys },
    'tasklist:select-all': { execute: deps.selectAll, enabled: deps.isActivePane },
    'tasklist:add-task': { execute: deps.newTask, enabled: deps.isActivePane },
    'tasklist:new-task': { execute: deps.newTask, enabled: deps.isActivePane },
    'tasklist:move-up': { execute: () => deps.moveTask(-1), enabled: deps.isActivePane },
    'tasklist:move-down': { execute: () => deps.moveTask(1), enabled: deps.isActivePane },
  };
  const unregister = TASK_LIST_SHORTCUTS.map(({ id, label, binding }) =>
    registerCommandWithShortcut({ name: id, label, description: label, binding, ...run[id] }));
  return () => {
    for (const off of unregister) off();
  };
}
