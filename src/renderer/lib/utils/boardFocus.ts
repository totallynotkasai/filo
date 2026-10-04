/**
 * True when keyboard focus is inside `board`: the board element itself, or a
 * tile, card or button in it. A board's single-letter shortcuts (the Mind
 * Map's N, C, Enter and Backspace, Kanban's N and Shift+N) act only then.
 * Typed anywhere else (the vault sidebar, a toolbar, the page a closed menu
 * left focus on) they would make tiles, cards or connections the user never
 * asked for. Text fields inside the board keep their keys by their own rules.
 */
export function focusIsInBoard(board: Element | null | undefined, doc: Document = document): boolean {
  const active = doc.activeElement;
  return !!board && !!active && board.contains(active);
}
