/**
 * kanbanBoardKeys — the keys a Kanban board takes itself while focus is in
 * it (the board, a card, a column), text being typed aside:
 *   • "/" opens the find bar;
 *   • Escape clears the selection;
 *   • Delete / Backspace remove the selected cards;
 *   • the arrows move to the next card on screen, and keyboard focus goes
 *     with them, so the menu key (or Shift+F10) opens that card's menu;
 *   • Enter on the board or a card opens a text card's note.
 * Its N, Shift+N and Ctrl+N are registered commands (`kanbanShortcuts.ts`).
 *
 * The listener is on the window and acts only for events inside this board,
 * so a split view with two Kanban boards runs only the focused one's keys.
 */
import type { SelectionScope } from '../../stores/selection.svelte';
import { isEditableTextTarget } from '../utils/editableTarget';
import { cardPosition, focusCard, neighbourCard, type KanbanCardsOnScreen } from './kanbanKeyboardNav';

export interface KanbanBoardKeyDeps {
  /** The board's root element. */
  root(): HTMLElement | null;
  findBarOpen(): boolean;
  openFindBar(): void;
  selection: Pick<SelectionScope, 'selectedIds' | 'count' | 'select'>;
  clearSelection(): void;
  removeSelected(): void;
  /** The cards the board draws (`cardsOnScreen`). */
  cards(): KanbanCardsOnScreen;
  /** A card the arrows moved to: it becomes the anchor of a Shift-click range. */
  arrowedTo(tileId: string): void;
  /** Opens a text card's note; false for a card that has none. */
  openCard(tileId: string): boolean;
  announce(message: string): void;
}

type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

function isArrow(key: string): key is ArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
}

function hasModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
}

/** The board's keydown handler, for `window.addEventListener('keydown', …)`. */
export function makeKanbanBoardKeydown(deps: KanbanBoardKeyDeps): (e: KeyboardEvent) => void {
  /** The next card for an arrow key: from the focused card, else the first card on screen. */
  function arrowTarget(key: ArrowKey): { target: string | null; from: string | undefined } {
    const cards = deps.cards();
    const ids = [...deps.selection.selectedIds];
    const from = ids[ids.length - 1];
    const at = from === undefined ? null : cardPosition(cards, from);
    // A selected card no longer drawn (its column collapsed, a filter) starts from the top.
    if (!at) return { target: cards.flat[0] ?? null, from };
    return { target: neighbourCard(cards, at, key), from };
  }

  return (e: KeyboardEvent): void => {
    // A key a global shortcut already handled must not act twice.
    if (e.defaultPrevented) return;
    const root = deps.root();
    const target = e.target;
    if (!root || !(target instanceof Node) || !root.contains(target)) return;
    if (isEditableTextTarget(target)) return;

    if (e.key === '/' && !deps.findBarOpen()) {
      e.preventDefault();
      deps.openFindBar();
      return;
    }
    if (e.key === 'Escape' && deps.selection.count > 0) {
      e.preventDefault();
      deps.clearSelection();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && deps.selection.count > 0) {
      e.preventDefault();
      // The focused card is about to go: focus stays on the board, so the
      // keys go on working instead of falling to the page.
      if (target !== root) root.focus({ preventScroll: true });
      deps.removeSelected();
      return;
    }
    if (isArrow(e.key) && !hasModifier(e)) {
      const { target: next, from } = arrowTarget(e.key);
      if (next && next !== from) {
        e.preventDefault();
        deps.selection.select(next);
        deps.arrowedTo(next);
        focusCard(root, next);
        deps.announce('Card focused');
      }
      return;
    }
    // Enter on a button or link inside the board presses it; only on the
    // board itself or a card does it open the card.
    const onBoardOrCard = target === root || (target instanceof HTMLElement && target.classList.contains('tile-drop-zone'));
    if (e.key === 'Enter' && !hasModifier(e) && onBoardOrCard && deps.selection.count === 1) {
      const [only] = deps.selection.selectedIds;
      if (only !== undefined && deps.openCard(only)) e.preventDefault();
    }
  };
}
