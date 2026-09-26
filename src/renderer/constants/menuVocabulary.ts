/**
 * The words and icons every context menu uses for the same action, so a user
 * who learns one menu can read the others. "Remove from board" never touches
 * the file; "Delete from vault…" moves it to Filo's trash. A label ends in "…"
 * when the action asks for more before it runs (a popup or a confirm).
 *
 * Menus list these in one order: Open, Style, Tags, Lock, Remove, Delete.
 * A menu leaves out what it doesn't offer; its other items keep a sensible
 * place around them.
 */
export const MENU_LABEL = {
  openAsDocument: 'Open as document',
  style: 'Style…',
  tags: 'Tags…',
  lock: 'Lock',
  unlock: 'Unlock',
  removeFromBoard: 'Remove from board',
  deleteFromVault: 'Delete from vault…',
} as const;

export const MENU_ICON = {
  openAsDocument: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  tags: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
  remove: 'M18 6L6 18M6 6l12 12',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  rename: 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  add: 'M12 5v14M5 12h14',
  moveTo: 'M5 12h14M13 5l7 7-7 7',
} as const;

/** "1 card", "3 cards". */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The heading over a menu that acts on a selection: "1 card selected", "3 cards selected". */
export function selectedHeading(count: number, singular: string, plural?: string): string {
  return `${countOf(count, singular, plural)} selected`;
}

/** Ctrl+L's rule: Lock when any item is unlocked, else Unlock. */
export function lockLabel(anyUnlocked: boolean): string {
  return anyUnlocked ? MENU_LABEL.lock : MENU_LABEL.unlock;
}
