import type { Tile } from '../../schema/index';
import { isModalDialogOpen } from '../utils/modalOpen';
import { isContentEditableAware } from '../utils/editableTarget';

interface NeighborSelectionInput {
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
  anchor: Tile;
  candidates: readonly Tile[];
  excludeIds: ReadonlySet<string>;
}

/**
 * Find the nearest neighboring tile in the given arrow-key direction,
 * relative to an anchor tile. Centre-to-centre distance with directional
 * filtering (the dominant axis must point in the requested direction).
 * Returns null when nothing qualifies.
 */
export function findNeighborTile(input: NeighborSelectionInput): Tile | null {
  const { key, anchor, candidates, excludeIds } = input;
  const ax = anchor.position.x + anchor.size.width / 2;
  const ay = anchor.position.y + anchor.size.height / 2;

  let best: Tile | null = null;
  let bestDist = Infinity;

  for (const t of candidates) {
    if (excludeIds.has(t.id)) continue;
    const tx = t.position.x + t.size.width / 2;
    const ty = t.position.y + t.size.height / 2;
    const dx = tx - ax;
    const dy = ty - ay;

    let valid = false;
    if (key === 'ArrowRight' && dx > 0 && Math.abs(dx) > Math.abs(dy)) valid = true;
    if (key === 'ArrowLeft' && dx < 0 && Math.abs(dx) > Math.abs(dy)) valid = true;
    if (key === 'ArrowDown' && dy > 0 && Math.abs(dy) > Math.abs(dx)) valid = true;
    if (key === 'ArrowUp' && dy < 0 && Math.abs(dy) > Math.abs(dx)) valid = true;

    if (valid) {
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = t;
      }
    }
  }

  return best;
}

/** True when the focused element should keep arrow keys (and letters) for its own use. */
export function isArrowConsumingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return isContentEditableAware(target) || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"], dialog';
/** The vault sidebar, docked or floating: its tree moves, opens and renames with these keys itself. */
const SIDEBAR_SELECTOR = '.vault-sidebar, .floating-vault-panel';
/** Controls that act on Enter / Space themselves. */
const ACTIVATES_SELECTOR = 'button, a[href], select, summary, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="tab"], [role="option"], [role="checkbox"], [role="switch"]';
/** Controls that move on the arrow keys themselves. */
const ARROWS_SELECTOR = 'select, [role="tab"], [role="option"], [role="radio"], [role="slider"]';

/**
 * True when a Mind Map key shortcut (N, C, Enter, Backspace, Delete, the
 * arrows) must leave the key alone: a modal dialog is open (Settings, a
 * confirm), focus is inside a dialog, menu or popup or in the vault sidebar,
 * or a focused control uses this key itself (Enter on a button, arrows in a
 * tab strip).
 *
 * DECISION: letters, Backspace and Delete still reach the board while a
 * plain button has focus (a toolbar button just clicked, a tile's lock
 * button), because a button has no use for them.
 */
export function isCanvasKeyBlocked(key: string, active: Element | null, doc: Document = document): boolean {
  if (isModalDialogOpen(doc)) return true;
  if (!active || active === doc.body) return false;
  if (active.closest(OVERLAY_SELECTOR) || active.closest(SIDEBAR_SELECTOR)) return true;
  if (isArrowConsumingTarget(active)) return true;
  if (key === 'Enter' || key === ' ') return active.closest(ACTIVATES_SELECTOR) !== null;
  if (isArrowKey(key)) return active.closest(ARROWS_SELECTOR) !== null;
  return false;
}

/** Discriminate the four arrow keys. */
export function isArrowKey(key: string): key is NeighborSelectionInput['key'] {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight';
}
