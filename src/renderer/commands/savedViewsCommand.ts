/**
 * Undoable saved-views CRUD for both Kanban and Task List boards. Saved
 * views live on `board.settings.savedViews` and are persisted via
 * `boardCacheStore.setKanbanSavedViews` / `setTaskListSavedViews`. One
 * Command class drives both surfaces via a `kind` discriminator.
 *
 * The step is kept as what it changed, view by view: the views it added, the
 * views it removed (with where they stood), and the keys it changed in the
 * views it kept. Undo and redo apply only that to the list as it stands, so
 * a change made since by anything else stays: a vault-wide tag rename that
 * rewrote another view's filter, or a view saved after this step.
 */

import { Command } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { applyKeyDelta, isEmptyKeyDelta, keyDelta, type KeyDelta } from './keyDelta';

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

/** What a step did to the list of saved views. */
interface ViewsDelta {
  /** Views it added, with their place in the list. */
  added: Array<{ view: SavedView; index: number }>;
  /** Ids of the views it removed. */
  removed: string[];
  /** Keys it changed in views it kept, by view id. */
  changed: Array<{ id: string; delta: KeyDelta }>;
}

function viewsDelta(from: readonly SavedView[], to: readonly SavedView[]): ViewsDelta {
  const before = new Map(from.map((v) => [v.id, v]));
  const after = new Set(to.map((v) => v.id));
  const delta: ViewsDelta = { added: [], removed: [], changed: [] };
  to.forEach((view, index) => {
    const prior = before.get(view.id);
    if (!prior) {
      delta.added.push({ view, index });
      return;
    }
    const keys = keyDelta(prior, view);
    if (!isEmptyKeyDelta(keys)) delta.changed.push({ id: view.id, delta: keys });
  });
  for (const view of from) if (!after.has(view.id)) delta.removed.push(view.id);
  return delta;
}

/** `current` with `delta` applied; views changed or removed since are left as they are. */
function applyViewsDelta(current: readonly SavedView[], delta: ViewsDelta): SavedView[] {
  const removed = new Set(delta.removed);
  let next = current.filter((v) => !removed.has(v.id));
  next = next.map((view) => {
    const change = delta.changed.find((c) => c.id === view.id);
    return change ? (applyKeyDelta(view, change.delta) as SavedView) : view;
  });
  for (const { view, index } of delta.added) {
    if (next.some((v) => v.id === view.id)) continue;
    next.splice(Math.min(index, next.length), 0, JSON.parse(JSON.stringify(view)) as SavedView);
  }
  return next;
}

export class UpdateSavedViewsCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private boardId: string;
  private kind: SavedViewsKind;
  private forward: ViewsDelta;
  private inverse: ViewsDelta;

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
    // Snapshots first, so a later in-place change of either array (a
    // same-name overwrite that filters it) can't reach the deltas.
    const from = this.snapshot(before);
    const to = this.snapshot(after);
    this.forward = viewsDelta(from, to);
    this.inverse = viewsDelta(to, from);
    this.description = description ?? 'Update saved views';
  }

  private current(): SavedView[] {
    const settings = boardCacheStore.cache[this.boardId]?.board.settings as { savedViews?: unknown } | undefined;
    return Array.isArray(settings?.savedViews) ? (JSON.parse(JSON.stringify(settings.savedViews)) as SavedView[]) : [];
  }

  private apply(delta: ViewsDelta): void {
    const next = applyViewsDelta(this.current(), delta);
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
    this.apply(this.forward);
  }

  undo() {
    this.apply(this.inverse);
  }
}
