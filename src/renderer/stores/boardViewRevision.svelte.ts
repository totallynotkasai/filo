/**
 * A board's view revision: bumped when its cached data is replaced from
 * outside the board view (a reload from disk, a rollback) or its saved view
 * state is rewritten (a vault-wide tag rename or delete).
 *
 * A mounted Kanban / Task List hydrates its filters from `settings.lastView`
 * once per board and writes them back on every save and unmount. Keyed on the
 * board id alone, it kept the filters it had before such a change and wrote
 * them over the new `lastView`. Keyed on id + revision, it hydrates again.
 */
import { SvelteMap } from 'svelte/reactivity';
import { onVaultSwap } from '../core/vaultLifecycle';

const revisions = new SvelteMap<string, number>();
onVaultSwap('pre-swap', 'boardViewRevision', () => revisions.clear());

/** The board's current view revision (reactive). */
export function boardViewRevision(boardId: string): number {
  return revisions.get(boardId) ?? 0;
}

/** Tells every mounted view of `boardId` to hydrate its view state again. */
export function bumpBoardViewRevision(boardId: string): void {
  revisions.set(boardId, boardViewRevision(boardId) + 1);
}

/** Which board, at which revision, a view last hydrated its view state from. */
export class ViewHydration {
  boardId = $state<string | null>(null);
  private revision = -1;

  /** True when `boardId` is a different board, or its revision moved on. */
  needs(boardId: string): boolean {
    return boardId !== this.boardId || boardViewRevision(boardId) !== this.revision;
  }

  mark(boardId: string): void {
    this.boardId = boardId;
    this.revision = boardViewRevision(boardId);
  }
}
