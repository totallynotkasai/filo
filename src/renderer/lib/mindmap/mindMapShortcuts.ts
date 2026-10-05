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
import type { ShortcutBinding } from '../../core/hotkeys';
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
  const shortcuts: Array<[string, string, ShortcutBinding, () => void, () => boolean]> = [
    ['mindmap:new-tile', 'Mind Map: New tile beside the selection', { key: 'n' }, deps.newTile, always],
    ['mindmap:connect', 'Mind Map: Connect the selected tile', { key: 'c' }, deps.connectSelected, one],
    ['mindmap:rename-tile', 'Mind Map: Rename the selected tile', { key: 'Enter' }, deps.renameSelected, one],
    ['mindmap:remove-tiles', 'Mind Map: Remove the selected tiles', { key: 'Backspace' }, deps.removeSelected, some],
  ];
  const unregister = shortcuts.map(([name, label, binding, execute, when]) =>
    registerCommandWithShortcut({ name, label, description: label, binding, enabled: owns(binding.key, when), execute }));
  return () => {
    for (const off of unregister) off();
  };
}
