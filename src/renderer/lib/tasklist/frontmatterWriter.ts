import type {
  TaskListBoard as TaskListBoardType,
  Tile,
} from '../../schema/index';
import { historyStore, type Command } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { noteStore } from '../../stores/notes.svelte';
import { BatchCommand, UpdateTaskFieldCommand } from '../../commands/index';
import { nextDueDate } from '../tasks/recurrence';
import type { Priority } from '../tasks/frontmatterReaders';
import type { TaskRow } from '../tasks/taskListModel';

import { resolveTextTileVaultPath } from '../boards/textTilePath';
/**
 * Frontmatter-writer slice for TaskListBoard.
 *
 * A task's fields live in its note's frontmatter. Each edit is an undoable
 * `UpdateTaskFieldCommand`, which sends it to the note writer as a delta;
 * the notes box sets the note's body through the note store.
 *
 * Mirrors `kanbanFrontmatterWriter.ts`. Factory closes over reactive
 * accessors (board, vaultPathForTile, bumpCacheVersion) so writers always
 * see the live host state.
 */

/**
 * Computes the frontmatter patch for marking a single (currently incomplete)
 * row complete. A recurring task does NOT complete — it rolls forward: the
 * next instance's due date is computed from the live row (current due +
 * recurrence + mode) and written back, keeping `completed: false`.
 *
 * Schedule mode (the default) needs an anchor `dueDate`; without one
 * `nextDueDate` returns null. Rather than terminating the recurrence, we seed
 * the next instance from the completion day (completion-mode semantics) so the
 * task keeps recurring. Only a genuinely unparseable `recurrence` string (both
 * modes return null) falls back to a plain completion.
 *
 * Shared by the single-row `toggleCompleted` and the bulk
 * `multiSelectController.bulkMarkComplete` so the two "mark complete" paths
 * can't diverge (e.g. one permanently completing repeating tasks).
 *
 * Pure given `now`; defaults to the current time for production callers.
 */
export function completionPatchForRow(
  row: TaskRow,
  now: Date = new Date(),
): Record<string, unknown> {
  if (row.recurrence) {
    let next = nextDueDate(row.dueDate || undefined, row.recurrence, row.recurrenceMode, now);
    // Schedule mode with no anchor date returns null; fall back to
    // completion-mode (next = completion day + interval) so recurrence survives.
    if (!next && row.recurrenceMode !== 'completion') {
      next = nextDueDate(row.dueDate || undefined, row.recurrence, 'completion', now);
    }
    if (next) return { completed: false, dueDate: next };
  }
  return { completed: true };
}

export interface FrontmatterWriterDeps {
  getBoard: () => TaskListBoardType | null;
  /**
   * Resolves the tile's canonical vault-relative `.md` path. Injected so
   * deletion / rename / writer slices all agree on the resolution path.
   */
  vaultPathForTile: (tile: Tile) => string;
  /** Re-reads the canonical frontmatter from vaultIndexStore for `tile`. */
  readFrontmatter: (tile: Tile) => Record<string, unknown>;
  /** Bumps the host's reactivity tick so derived views re-render. */
  bumpCacheVersion: () => void;
  /**
   * Screen-reader announcer (aria-live region), used to
   * announce a FAILED bulk mark-incomplete. The visual error toast already
   * comes from the command chain's reportError pipeline; this gives SR users
   * parity with it. Optional so older test harnesses keep constructing deps.
   */
  announce?: (message: string) => void;
}

export interface FrontmatterWriter {
  ensureSeededFm(tile: Tile): string | null;
  buildTaskFieldCommand(
    row: TaskRow,
    patch: Record<string, unknown>,
    description?: string,
  ): UpdateTaskFieldCommand | null;
  updateRowField(row: TaskRow, patch: Record<string, unknown>): Promise<void>;
  toggleCompleted(row: TaskRow): Promise<void>;
  setRecurrence(row: TaskRow, recurrence: string): Promise<void>;
  cyclePriority(row: TaskRow): Promise<void>;
  setDueDate(row: TaskRow, dueDate: string): Promise<void>;
  setDueTime(row: TaskRow, dueTime: string): Promise<void>;
  setStartDate(row: TaskRow, startDate: string): Promise<void>;
  setNotesBody(row: TaskRow, body: string): Promise<void>;
  markAllIncomplete(rows: TaskRow[]): Promise<void>;
}

export function makeFrontmatterWriter(deps: FrontmatterWriterDeps): FrontmatterWriter {
  const { getBoard, readFrontmatter, bumpCacheVersion, announce } = deps;

  /** The tile's note path (the note store answers its frontmatter directly). */
  function ensureSeededFm(tile: Tile): string | null {
    return resolveTextTileVaultPath(tile);
  }

  /**
   * Builds a single UpdateTaskFieldCommand for a row's frontmatter patch.
   * Captures the inverse patch (previous values for each affected key) so
   * undo restores the exact prior state. Returns `null` for a row with no
   * note (not a text tile).
   */
  function buildTaskFieldCommand(
    row: TaskRow,
    patch: Record<string, unknown>,
    description?: string,
  ): UpdateTaskFieldCommand | null {
    const board = getBoard();
    if (!board) return null;
    const path = resolveTextTileVaultPath(row.tile);
    if (!path) return null;
    // Best-effort inverse from the vault index; the command recomputes it from
    // the note as it stands on execute, so undo restores the true prior value.
    const before = readFrontmatter(row.tile);
    const inverse: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      // mergeFrontmatter's cleaning rule deletes empty/null/undefined values,
      // so absent previous keys map to '' (which restores the absent state).
      inverse[key] = key in before ? before[key] : '';
    }
    // A patch carrying BOTH `completed` and `dueDate` is, in this code, a
    // recurrence roll-forward: `completionPatchForRow` is the ONLY producer of
    // that shape (every other task field setter — priority, due, start, status,
    // a plain (un)complete — is single-key). Mark it atomic so undo/redo can't
    // split the coupled pair when an external editor touched just one of the two
    // keys in between (which would leave `completed: true` + an advanced due).
    // This chokepoint serves both the single-row (toggleCompleted) and bulk
    // (bulkMarkComplete) paths, since both build commands through here.
    const atomic = 'completed' in patch && 'dueDate' in patch;
    return new UpdateTaskFieldCommand(board.id, path, patch, inverse, description, atomic);
  }

  async function updateRowField(row: TaskRow, patch: Record<string, unknown>): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const cmd = buildTaskFieldCommand(row, patch);
    // Await the command so this resolves once the change is queued and shows
    // on the row; the chain reports its own errors, so swallow the rejection
    // on this fire-and-forget UI path.
    if (cmd) await historyStore.execute(cmd).catch(() => {});
    bumpCacheVersion();
  }

  async function toggleCompleted(row: TaskRow): Promise<void> {
    // Completing routes through the shared `completionPatchForRow` so the
    // recurrence roll-forward stays identical to the bulk path.
    // Un-completing is a plain `completed: false`.
    const patch = row.completed ? { completed: false } : completionPatchForRow(row);
    await updateRowField(row, patch);
    // A recurring roll-forward keeps completed:false and advances the due
    // date, so the checkbox just snaps back with no other signal. Announce the new
    // date so the reschedule is visible (only when completing produced the
    // {completed:false, dueDate} roll-forward shape, not a plain (un)complete).
    if (!row.completed && patch.completed === false && typeof patch.dueDate === 'string') {
      uiStore.toast(`Recurring task rescheduled to ${patch.dueDate}`, 'info', 2500);
    }
  }

  function setRecurrence(row: TaskRow, recurrence: string): Promise<void> {
    // Clearing recurrence intentionally leaves `recurrenceMode` in place so
    // a later re-add picks up the user's last-chosen mode.
    return updateRowField(row, { recurrence });
  }

  function cyclePriority(row: TaskRow): Promise<void> {
    const order: Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];
    const next = order[(order.indexOf(row.priority) + 1) % order.length];
    return updateRowField(row, { priority: next === 'none' ? '' : next });
  }

  function setDueDate(row: TaskRow, dueDate: string): Promise<void> {
    // Clearing the due date also clears any dueTime, in ONE command (a single
    // undo entry). A dangling dueTime with no dueDate is invisible anyway — the
    // chip only renders inside `{#if dueDate}`. A non-empty date leaves the time untouched.
    if (!dueDate && row.dueTime) {
      return updateRowField(row, { dueDate: '', dueTime: '' });
    }
    return updateRowField(row, { dueDate });
  }

  function setDueTime(row: TaskRow, dueTime: string): Promise<void> {
    return updateRowField(row, { dueTime });
  }

  function setStartDate(row: TaskRow, startDate: string): Promise<void> {
    return updateRowField(row, { startDate });
  }

  /** The notes box: sets the task note's body (a row with no note has none). */
  async function setNotesBody(row: TaskRow, body: string): Promise<void> {
    const path = resolveTextTileVaultPath(row.tile);
    if (path) await noteStore.writeBody(path, body);
    bumpCacheVersion();
  }

  async function markAllIncomplete(rows: TaskRow[]): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const cmds: Command[] = [];
    for (const r of rows) {
      if (!r.completed) continue;
      // Each row's disk pre-seed runs inside UpdateTaskFieldCommand.execute();
      // BatchCommand awaits its children's execute() in order, so the
      // seeds + writes all run on the history chain that save()/quit drain.
      const cmd = buildTaskFieldCommand(r, { completed: false }, 'Mark incomplete');
      if (cmd) cmds.push(cmd);
    }
    if (cmds.length === 0) {
      uiStore.toast('No completed tasks to mark', 'info', 2000);
      return;
    }
    // Await the batch so the per-row disk seeds + writes (inside each child's
    // execute()) finish before the confirmation toast.
    //
    // The success toast is GATED on the chain resolving (a rejected batch
    // rolled back). On failure we only announce for screen readers (the visual
    // error toast already exists); the rejection stays swallowed.
    const ok = await historyStore
      .execute(new BatchCommand(`Mark ${cmds.length} tasks incomplete`, cmds))
      .then(() => true, () => false);
    bumpCacheVersion();
    if (ok) {
      uiStore.toast(
        `${cmds.length} task${cmds.length === 1 ? '' : 's'} marked incomplete`,
        'success',
        2000,
      );
    } else {
      announce?.('Marking tasks incomplete failed — see the error notification');
    }
  }

  return {
    ensureSeededFm,
    buildTaskFieldCommand,
    updateRowField,
    toggleCompleted,
    setRecurrence,
    cyclePriority,
    setDueDate,
    setDueTime,
    setStartDate,
    setNotesBody,
    markAllIncomplete,
  };
}
