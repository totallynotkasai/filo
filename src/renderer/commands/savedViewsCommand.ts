/**
 * Undoable saved-views CRUD for both Kanban and Task List boards. Saved
 * views live on `board.settings.savedViews` and are persisted via
 * `boardCacheStore.setKanbanSavedViews` / `setTaskListSavedViews`. One
 * Command class drives both surfaces via a `kind` discriminator.
 *
 * Snapshots are deep-cloned via JSON round-trip so a later in-place
 * mutation of either array (e.g. a same-name overwrite that filters the
 * array) doesn't poison the inverse used by undo.
 */

import { Command } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';

export type SavedViewsKind = 'kanban' | 'tasklist';

/**
 * Loose type alias — both Kanban and Task List saved-view objects share an
 * `{ id, name, … }` shape but their per-view fields differ. The command
 * only ever round-trips the array via the boardCacheStore writers, so a
 * permissive structural alias is enough.
 *
 * Note: we deliberately don't use `Record<string, unknown>` here because
 * Svelte's interface-based saved-view types (`SavedKanbanView`,
 * `filtersAndViews.SavedView`) don't carry an index signature and would
 * not be assignable to it. Accepting an `unknown[]` at the boundary keeps
 * both call sites typesafe without forcing them to add an index signature
 * to their concrete saved-view definitions.
 */
export type SavedView = { id: string; name: string };

export class UpdateSavedViewsCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private kind: SavedViewsKind;
  private before: SavedView[];
  private after: SavedView[];

  constructor(
    boardId: string,
    kind: SavedViewsKind,
    before: SavedView[],
    after: SavedView[],
    description?: string,
  ) {
    super();
    this.boardId = boardId;
    this.targetBoardId = boardId;
    this.kind = kind;
    this.before = this.snapshot(before);
    this.after = this.snapshot(after);
    this.description = description ?? 'Update saved views';
  }

  private apply(next: SavedView[]): void {
    if (this.kind === 'kanban') {
      // The Kanban setter is typed against its own concrete saved-view
      // shape. The structural cast is safe because we round-trip the
      // exact same JSON payload the caller already validated.
      boardCacheStore.setKanbanSavedViews(
        this.boardId,
        next as Parameters<typeof boardCacheStore.setKanbanSavedViews>[1],
      );
    } else {
      boardCacheStore.setTaskListSavedViews(
        this.boardId,
        next as Parameters<typeof boardCacheStore.setTaskListSavedViews>[1],
      );
    }
  }

  execute() {
    this.apply(this.snapshot(this.after));
  }

  undo() {
    this.apply(this.snapshot(this.before));
  }
}
