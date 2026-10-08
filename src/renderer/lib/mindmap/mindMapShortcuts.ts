/**
 * mindMapShortcuts — the Mind Map's single-key shortcuts, registered while a
 * Mind Map is mounted. Each has a command id, so it is listed in Help →
 * Shortcuts and can be rebound there (`.filo/hotkeys.json`), as every other
 * shortcut can.
 *
 * Each acts only for the focused pane (a split view can mount two Mind Maps)
 * and only while focus is in this canvas (`focusIsInBoard`): typed in the
 * sidebar, a toolbar or on the page, they would make, rename or delete tiles
 * the user wasn't looking at. A dialog, menu or focused control that uses the
 * key itself keeps it (`isCanvasKeyBlocked`). Text being typed never reaches
 * them (the shortcut registry leaves editors and fields alone).
 */
import { registerCommandWithShortcut } from '../../core/commandRegistry';
import { MIND_MAP_SHORTCUTS } from '../../constants/shortcutReference';
import { focusIsInBoard } from '../utils/boardFocus';
import { isCanvasKeyBlocked } from './mindMapKeyboard';

export interface MindMapShortcutDeps {
  /** True while this board's pane is the active one. */
  isActivePane(): boolean;
  /** The board's canvas element. */
  canvas(): Element | null | undefined;
  /** How many tiles are selected (shown ones only). */
  selectedCount(): number;
  /** A new text tile beside the selection, or in the middle of the view. */
  newTile(): void;
  /** Opens the one selected tile's title for typing. */
  renameSelected(): void;
  /** Asks to remove the selected tiles from the board. */
  removeSelected(): void;
  /** Starts a connection from the one selected tile. */
  connectSelected(): void;
}

type MindMapCommandId = (typeof MIND_MAP_SHORTCUTS)[number]['id'];

/** Registers the Mind Map's shortcuts; the returned function removes them. */
export function registerMindMapShortcuts(deps: MindMapShortcutDeps): () => void {
  const one = (): boolean => deps.selectedCount() === 1;
  const some = (): boolean => deps.selectedCount() > 0;
  const always = (): boolean => true;
  // A key with nothing to act on is left alone (not taken from the page).
  // The default key decides what a focused control would do with it (Enter
  // presses a button); a key rebound in its place is checked the same way.
  const owns = (key: string, when: () => boolean) => (): boolean =>
    deps.isActivePane() && focusIsInBoard(deps.canvas()) && !isCanvasKeyBlocked(key, document.activeElement) && when();
  const run: Record<MindMapCommandId, { execute: () => void; when: () => boolean }> = {
    'mindmap:new-tile': { execute: deps.newTile, when: always },
    'mindmap:connect': { execute: deps.connectSelected, when: one },
    'mindmap:rename-tile': { execute: deps.renameSelected, when: one },
    'mindmap:remove-tiles': { execute: deps.removeSelected, when: some },
  };
  const unregister = MIND_MAP_SHORTCUTS.map(({ id, label, binding }) => {
    const { execute, when } = run[id];
    return registerCommandWithShortcut({ name: id, label, description: label, binding, enabled: owns(binding.key, when), execute });
  });
  return () => {
    for (const off of unregister) off();
  };
}
