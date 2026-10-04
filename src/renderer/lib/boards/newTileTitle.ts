/**
 * newTileTitle — a tile or card the user just made opens with its title
 * selected for editing, so typing names it.
 *
 * Without this, focus stayed on the button that made it (Kanban's Add Card,
 * which the space bar then pressed again) or fell to the page (the Mind Map,
 * whose single-letter keys then made more tiles, each with an empty note).
 *
 * The tile's header mounts a moment after the command that adds it runs, so
 * the request waits here until that header takes it. One not taken soon
 * (the tile landed off screen, or a filter hides the card) is dropped, so it
 * never starts an edit later when the tile scrolls into view.
 */
import { vaultSwapResettable } from '../../core/vaultLifecycle';

/** How long a request waits for its tile's header to mount. */
const TAKE_WITHIN_MS = 2000;

/** Tile id → when its title edit was asked for. */
const requested = new Map<string, number>();

vaultSwapResettable('newTileTitle', () => {
  requested.clear();
});

/** The tile `tileId` was just made by the user: its header opens the title for editing. */
export function editTitleWhenShown(tileId: string): void {
  requested.set(tileId, Date.now());
}

/** True, once, when the header of `tileId` should open its title for editing now. */
export function takeTitleEdit(tileId: string): boolean {
  const at = requested.get(tileId);
  if (at === undefined) return false;
  requested.delete(tileId);
  return Date.now() - at <= TAKE_WITHIN_MS;
}
