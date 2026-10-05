import { isEditableTextTarget } from '../utils/editableTarget';

/**
 * A popup, menu or dialog that holds the focus: Escape is its, not the
 * Search panel's.
 */
const POPUP_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]';

/**
 * Whether an Escape pressed outside the Search panel closes it.
 *
 * The panel is the lowest layer that listens for Escape. Whatever sits above
 * it and uses the key (a confirm, a dialog, a menu, a popup, a board's
 * selection or connection mode) calls `preventDefault`, and a key pressed in
 * a text field or editor belongs to the edit (it ends a title, or clears a
 * search box). So this is read once the whole dispatch is over, when a
 * listener registered after the panel's has had its say too.
 */
export function escapeClosesSearchPanel(e: KeyboardEvent, panel: Element | null): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented) return false;
  const target = e.target;
  // The window or the document: nothing has the focus.
  if (!(target instanceof Element)) return true;
  // The panel's own handler closes it.
  if (panel?.contains(target)) return false;
  if (target instanceof HTMLElement && isEditableTextTarget(target)) return false;
  return target.closest(POPUP_SELECTOR) === null;
}
