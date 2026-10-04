/**
 * kanbanShortcuts — a Kanban board's own shortcuts, registered while it is
 * mounted. Each has a command id, so it shows up in Settings → Keyboard
 * Shortcuts and can be rebound.
 *
 * Every one acts only for the focused pane: a split view can mount two
 * boards sharing a key (`n` is also the Task List's), and a skipped shortcut
 * lets the other pane's take the key (see `enabled` in `core/hotkeys.ts`).
 * The bare N and Shift+N act only while focus is in the board as well
 * (`focusIsInBoard`), so typing in the sidebar or after a menu closed never
 * adds a card or a column. Ctrl+N is the Mind Map's New Tile; that command
 * stands aside off the Mind Map, so here it adds a card like N does.
 */
import { registerCommandWithShortcut } from '../../core/commandRegistry';
import type { ShortcutBinding } from '../../core/hotkeys';
import { focusIsInBoard } from '../utils/boardFocus';

export interface KanbanShortcutDeps {
  /** True while this board's pane is the active one. */
  isActivePane(): boolean;
  /** The board's root element. */
  boardRoot(): Element | null | undefined;
  /** Opens the new-card picker for the target column. */
  addCard(): void;
  addColumn(): void;
}

/** Registers the board's shortcuts; the returned function removes them. */
export function registerKanbanShortcuts(deps: KanbanShortcutDeps): () => void {
  const ownsBareKeys = (): boolean => deps.isActivePane() && focusIsInBoard(deps.boardRoot());
  const shortcuts: Array<[string, string, ShortcutBinding, () => void, () => boolean]> = [
    ['kanban:add-tile', 'Kanban: Add tile', { key: 'n' }, deps.addCard, ownsBareKeys],
    ['kanban:new-card', 'Kanban: New card', { key: 'n', ctrl: true }, deps.addCard, deps.isActivePane],
    ['kanban:add-column', 'Kanban: Add column', { key: 'n', shift: true }, deps.addColumn, ownsBareKeys],
  ];
  const unregister = shortcuts.map(([name, label, binding, execute, enabled]) =>
    registerCommandWithShortcut({ name, label, description: label, binding, enabled, execute }));
  return () => {
    for (const off of unregister) off();
  };
}
