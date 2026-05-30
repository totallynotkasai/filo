/**
 * Keyboard equivalent for right-click context menus (WCAG 2.1.1).
 *
 * Listens for Shift+F10 and the dedicated ContextMenu / "Apps" key, then
 * invokes the same handler the component uses for `contextmenu` events,
 * positioned at the centre of the focused element's bounding box.
 *
 * Components attach this via `onkeydown={(e) => handleContextMenuKey(e, openMenu)}`
 * — the handler is responsible for opening the menu itself; this helper
 * only normalises the trigger and supplies a synthetic clientX/clientY.
 */

export interface ContextMenuPosition {
  /** Viewport x for the menu. */
  x: number;
  /** Viewport y for the menu. */
  y: number;
}

function isContextMenuKey(e: KeyboardEvent): boolean {
  // ContextMenu key — official name on Windows keyboards.
  if (e.key === 'ContextMenu') return true;
  // Shift+F10 — universal keyboard equivalent across platforms.
  if (e.key === 'F10' && e.shiftKey) return true;
  return false;
}

/**
 * Returns the position at which the menu should open, or `null` if the
 * event is not a context-menu key. The caller still has to call
 * `preventDefault` / `stopPropagation` itself — this helper only computes
 * the geometry so the policy stays at the call site.
 */
export function getContextMenuKeyPosition(
  e: KeyboardEvent,
  target: HTMLElement | null,
): ContextMenuPosition | null {
  if (!isContextMenuKey(e)) return null;
  // Prefer the event's currentTarget, fall back to the active element.
  const el = target ?? (document.activeElement as HTMLElement | null);
  if (!el) return { x: 0, y: 0 };
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };
}
