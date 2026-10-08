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
import { KANBAN_SHORTCUTS } from '../../constants/shortcutReference';
import { focusIsInBoard } from '../utils/boardFocus';

export interface KanbanShortcutDeps {
  /** True while this board's pane is the active one. */
  isActivePane(): boolean;
  /** The board's root element. */
  boardRoot(): Element | null | undefined;
  /** Opens the new-card picker for the target column. */
  addCard(): void;
  addColumn(): void;
  /** Selects every card on screen (a collapsed column's none). */
  selectAll(): void;
}

type KanbanCommandId = (typeof KANBAN_SHORTCUTS)[number]['id'];

/** Registers the board's shortcuts; the returned function removes them. */
export function registerKanbanShortcuts(deps: KanbanShortcutDeps): () => void {
  const ownsBareKeys = (): boolean => deps.isActivePane() && focusIsInBoard(deps.boardRoot());
  const run: Record<KanbanCommandId, { execute: () => void; enabled: () => boolean }> = {
    'kanban:add-tile': { execute: deps.addCard, enabled: ownsBareKeys },
    'kanban:new-card': { execute: deps.addCard, enabled: deps.isActivePane },
    'kanban:add-column': { execute: deps.addColumn, enabled: ownsBareKeys },
    'kanban:select-all': { execute: deps.selectAll, enabled: deps.isActivePane },
  };
  const unregister = KANBAN_SHORTCUTS.map(({ id, label, binding }) =>
    registerCommandWithShortcut({ name: id, label, description: label, binding, ...run[id] }));
  return () => {
    for (const off of unregister) off();
  };
}
