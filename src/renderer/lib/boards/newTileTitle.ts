/**
 * newTileTitle — a tile or card the user just made opens with its title
 * selected for editing, so typing names it. So does the tab of a note made
 * with New note (keyed by the tab's id).
 *
 * Without this, focus stayed on the button that made it (Kanban's Add Card,
 * which the space bar then pressed again) or fell to the page (the Mind Map,
 * whose single-letter keys then made more tiles, each with an empty note).
 *
 * The tile's header mounts a moment after the command that adds it runs, so
 * the request waits here until that header takes it. One not taken soon
 * (the tile landed off screen, its column is collapsed) is dropped, so it
 * never starts an edit later when the tile scrolls into view.
 *
 * A caller may ask to hear when the title is done (`onDone`): once the edit
 * the header opened ends, or at once when no header took the request in
 * time. Kanban keeps a card a filter would hide on screen until then.
 */
import { vaultSwapResettable } from '../../core/vaultLifecycle';

/** How long a request waits for its tile's header to mount. */
const TAKE_WITHIN_MS = 2000;

interface Request {
  at: number;
  onDone?: () => void;
  /** Drops a request no header took, telling `onDone`. */
  expiry?: ReturnType<typeof setTimeout>;
}

/** Tile id → its request, until a header takes it (or it expires). */
const requested = new Map<string, Request>();
/** Tile id → `onDone` of an edit a header took and hasn't ended yet. */
const editing = new Map<string, () => void>();

vaultSwapResettable('newTileTitle', () => {
  for (const r of requested.values()) if (r.expiry) clearTimeout(r.expiry);
  requested.clear();
  editing.clear();
});

/** The tile `tileId` was just made by the user: its header opens the title for editing. */
export function editTitleWhenShown(tileId: string, onDone?: () => void): void {
  const prior = requested.get(tileId);
  if (prior?.expiry) clearTimeout(prior.expiry);
  const request: Request = { at: Date.now(), onDone };
  if (onDone) {
    request.expiry = setTimeout(() => {
      if (requested.get(tileId) !== request) return;
      requested.delete(tileId);
      onDone();
    }, TAKE_WITHIN_MS);
  }
  requested.set(tileId, request);
}

/** True, once, when the header of `tileId` should open its title for editing now. */
export function takeTitleEdit(tileId: string): boolean {
  const request = requested.get(tileId);
  if (request === undefined) return false;
  requested.delete(tileId);
  if (request.expiry) clearTimeout(request.expiry);
  if (Date.now() - request.at > TAKE_WITHIN_MS) {
    request.onDone?.();
    return false;
  }
  if (request.onDone) editing.set(tileId, request.onDone);
  return true;
}

/** The edit a header opened through `takeTitleEdit` ended (named, or left as it was). */
export function newTitleEditEnded(tileId: string): void {
  const onDone = editing.get(tileId);
  editing.delete(tileId);
  onDone?.();
}
