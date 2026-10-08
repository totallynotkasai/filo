/**
 * What Help → Shortcuts lists besides the commands registered right now.
 *
 * A board registers its commands (N, Shift+N, Alt+Up …) only while it is
 * mounted, so each board's list lives here, and Help shows it whether that
 * board is open or not; its keys can be rebound either way. The board
 * modules register these same lists (`mindMapShortcuts.ts`,
 * `kanbanShortcuts.ts`, `taskListShortcuts.ts`).
 *
 * The fixed keys act on what has focus (a card, a row, the text being typed)
 * through that view's own handler, so they aren't commands and can't be
 * rebound; Help lists them so every key the app answers is written down.
 */
import type { ShortcutBinding } from '../core/hotkeys';

/** One of a board's commands: its id, its label and its default key. */
export interface BoardCommand {
  readonly id: string;
  readonly label: string;
  readonly binding: ShortcutBinding;
}

export const MIND_MAP_SHORTCUTS = [
  { id: 'mindmap:new-tile', label: 'Mind Map: New tile beside the selection', binding: { key: 'n' } },
  { id: 'mindmap:connect', label: 'Mind Map: Connect the selected tile', binding: { key: 'c' } },
  { id: 'mindmap:rename-tile', label: 'Mind Map: Rename the selected tile', binding: { key: 'Enter' } },
  { id: 'mindmap:remove-tiles', label: 'Mind Map: Remove the selected tiles', binding: { key: 'Backspace' } },
] as const satisfies readonly BoardCommand[];

// A command with two keys is two commands of one name (each key can be rebound).
export const KANBAN_SHORTCUTS = [
  { id: 'kanban:add-tile', label: 'Kanban: New card', binding: { key: 'n' } },
  { id: 'kanban:new-card', label: 'Kanban: New card', binding: { key: 'n', ctrl: true } },
  { id: 'kanban:add-column', label: 'Kanban: Add column', binding: { key: 'n', shift: true } },
  { id: 'kanban:select-all', label: 'Kanban: Select all cards on screen', binding: { key: 'a', ctrl: true } },
] as const satisfies readonly BoardCommand[];

export const TASK_LIST_SHORTCUTS = [
  { id: 'tasklist:focus-quick-add', label: 'Task List: Focus quick-add input', binding: { key: 'n' } },
  { id: 'tasklist:select-all', label: 'Task List: Select all visible', binding: { key: 'a', ctrl: true } },
  { id: 'tasklist:add-task', label: 'Task List: New task', binding: { key: 'Enter', ctrl: true } },
  { id: 'tasklist:new-task', label: 'Task List: New task', binding: { key: 'n', ctrl: true } },
  { id: 'tasklist:move-up', label: 'Task List: Move task up', binding: { key: 'ArrowUp', alt: true } },
  { id: 'tasklist:move-down', label: 'Task List: Move task down', binding: { key: 'ArrowDown', alt: true } },
] as const satisfies readonly BoardCommand[];

export interface FixedKey {
  keys: string;
  description: string;
}

/** One board's (or the text's) part of Help: its commands, then its fixed keys. */
export interface ShortcutArea {
  title: string;
  commands: readonly BoardCommand[];
  fixed: readonly FixedKey[];
}

export const SHORTCUT_AREAS: readonly ShortcutArea[] = [
  {
    title: 'Mind Map',
    commands: MIND_MAP_SHORTCUTS,
    fixed: [
      { keys: 'Arrow keys', description: 'Select the nearest tile in that direction' },
      { keys: 'Ctrl+Shift+Arrow', description: 'Add the nearest tile in that direction to the selection' },
      { keys: 'Ctrl+Arrow', description: 'Move the selected tiles' },
      { keys: 'Escape', description: 'Stop drawing a connection, or clear the selection' },
      { keys: 'Shift+Drag', description: 'Select the tiles in an area' },
      { keys: 'Menu key or Shift+F10', description: 'The focused tile\'s menu' },
    ],
  },
  {
    title: 'Kanban',
    commands: KANBAN_SHORTCUTS,
    fixed: [
      { keys: 'Arrow keys', description: 'Go to the next card on screen' },
      { keys: 'Enter', description: 'Open the card\'s note' },
      { keys: 'Delete or Backspace', description: 'Remove the selected cards from the board' },
      { keys: 'Escape', description: 'Clear the selection' },
      { keys: '/', description: 'Find on this board' },
      { keys: 'Menu key or Shift+F10', description: 'The card\'s menu (Move to column…)' },
      { keys: 'F2 or Enter', description: 'Rename the focused column' },
      { keys: 'Alt+Left / Alt+Right', description: 'Move the focused column' },
    ],
  },
  {
    title: 'Task List',
    commands: TASK_LIST_SHORTCUTS,
    fixed: [
      { keys: 'Up / Down', description: 'Go to the task above or below' },
      { keys: 'Tab / Shift+Tab', description: 'Make the task a subtask of the one above / a level up' },
      { keys: 'Space', description: 'Complete the task, or mark it not done' },
      { keys: 'Enter', description: 'Rename the task' },
      { keys: 'Delete or Backspace', description: 'Remove the task from the board' },
      { keys: '1 to 4, 0', description: 'Priority: Urgent, High, Medium, Low; 0 clears it' },
      { keys: 'D', description: 'Set the due date' },
      { keys: 'Escape', description: 'Clear the selection' },
    ],
  },
  {
    title: 'Text',
    commands: [],
    fixed: [
      { keys: 'Ctrl+B / Ctrl+I / Ctrl+U', description: 'Bold / Italic / Underline' },
      { keys: 'Ctrl+Shift+S', description: 'Strikethrough' },
      { keys: 'Ctrl+E', description: 'Code' },
      { keys: 'Ctrl+Shift+H', description: 'Highlight' },
      { keys: 'Ctrl+Alt+1 to 6', description: 'Heading 1 to 6' },
      { keys: 'Ctrl+Alt+0', description: 'Normal text' },
      { keys: 'Ctrl+Shift+8 / 7 / 9', description: 'Bulleted / numbered list / checklist' },
      { keys: 'Ctrl+Shift+B', description: 'Quote' },
      { keys: 'Ctrl+Alt+C', description: 'Code block' },
      { keys: 'Ctrl+Shift+L / E / R / J', description: 'Align left / centre / right / justify' },
      { keys: 'Tab / Shift+Tab', description: 'A tab; on several lines, indent / outdent (a list item: a level in / out)' },
      { keys: 'Shift+Enter', description: 'Line break' },
      { keys: 'Ctrl+Z / Ctrl+Y', description: 'Undo / Redo' },
    ],
  },
];
