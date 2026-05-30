/**
 * Shared arrow-key navigation helper for lists of focusable items
 * (tablists, menus, tree views, etc.). Components hook this into their
 * own `onkeydown` handler so the focus model stays a roving-tabindex /
 * normal-focus pattern owned by the component.
 *
 * Returns `true` when the event was handled — the caller should follow
 * that with `e.preventDefault()` so list-arrow keys don't also scroll
 * the surrounding container.
 */

export type Orientation = 'horizontal' | 'vertical';

export interface ListKeyNavOptions {
  /** CSS selector to enumerate focusable items inside `container`. */
  selector: string;
  /** Horizontal = ArrowLeft/Right, vertical = ArrowUp/Down. */
  orientation?: Orientation;
  /** Wrap focus past the ends. Defaults to true (tablist convention). */
  wrap?: boolean;
}

function visibleFocusable(container: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
  );
}

export function handleListKeyNav(
  e: KeyboardEvent,
  container: HTMLElement,
  options: ListKeyNavOptions,
): boolean {
  const orientation = options.orientation ?? 'horizontal';
  const wrap = options.wrap ?? true;
  const nextKey = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const prevKey = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  if (
    e.key !== nextKey
    && e.key !== prevKey
    && e.key !== 'Home'
    && e.key !== 'End'
  ) {
    return false;
  }
  const items = visibleFocusable(container, options.selector);
  if (items.length === 0) return false;
  const active = document.activeElement as HTMLElement | null;
  const idx = active ? items.indexOf(active) : -1;
  let nextIdx: number;
  if (e.key === 'Home') {
    nextIdx = 0;
  } else if (e.key === 'End') {
    nextIdx = items.length - 1;
  } else if (e.key === nextKey) {
    if (idx === -1) nextIdx = 0;
    else if (idx === items.length - 1) nextIdx = wrap ? 0 : idx;
    else nextIdx = idx + 1;
  } else {
    // prevKey
    if (idx === -1) nextIdx = items.length - 1;
    else if (idx === 0) nextIdx = wrap ? items.length - 1 : 0;
    else nextIdx = idx - 1;
  }
  items[nextIdx].focus();
  return true;
}

/**
 * Convenience wrapper: focuses the first matching item inside a container.
 * Used by dropdowns/menus that should grab focus when they open.
 */
export function focusFirstItem(container: HTMLElement, selector: string): void {
  const items = visibleFocusable(container, selector);
  if (items.length > 0) items[0].focus();
}
