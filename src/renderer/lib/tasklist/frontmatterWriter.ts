import type {
  TaskListBoard as TaskListBoardType,
  Tile,
} from '../../schema/index';
import { historyStore, type Command } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { noteStore, type SetBodyStatus } from '../../stores/notes.svelte';
import { BatchCommand, UpdateTaskFieldCommand } from '../../commands/index';
import { nextDueDate, parseRecurrence, recurrenceAnchorToRecord, type RecurrenceMode } from '../tasks/recurrence';
import { FIELD_READERS, type Priority } from '../tasks/frontmatterReaders';
import { formatDay } from '../utils/dateFormat';
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
 *
 * The row is a first guess: `buildTaskFieldCommand` decides a completion
 * again from the note as it stands (`completionPatchForFrontmatter`), since
 * a row shown before its note's fields arrived has no recurrence yet.
 */
export function completionPatchForRow(
  row: Pick<TaskRow, 'dueDate' | 'recurrence' | 'recurrenceMode' | 'recurrenceAnchor'>,
  now: Date = new Date(),
): Record<string, unknown> {
  if (row.recurrence) {
    const due = row.dueDate || undefined;
    let next = nextDueDate(due, row.recurrence, row.recurrenceMode, now, row.recurrenceAnchor);
    // Schedule mode with no anchor date returns null; fall back to
    // completion-mode (next = completion day + interval) so recurrence survives.
    if (!next && row.recurrenceMode !== 'completion') {
      next = nextDueDate(due, row.recurrence, 'completion', now);
    }
    if (next) {
      const patch: Record<string, unknown> = { completed: false, dueDate: next };
      // The new due date may be a month-end clamp that forgets the original
      // day, so remember it in the same delta. A stale anchor (the due date
      // was moved by hand) is dropped so it can't be revived by a later move
      // onto a day it happens to match.
      const anchor = recurrenceAnchorToRecord(due, row.recurrence, row.recurrenceMode, row.recurrenceAnchor);
      if (anchor) {
        if (anchor !== row.recurrenceAnchor) patch.recurrenceAnchor = anchor;
      } else if (row.recurrenceAnchor) {
        patch.recurrenceAnchor = '';
      }
      return patch;
    }
  }
  return { completed: true };
}

/** `completionPatchForRow` for the task fields in a note's frontmatter. */
export function completionPatchForFrontmatter(
  fm: Readonly<Record<string, unknown>>,
  now: Date = new Date(),
): Record<string, unknown> {
  return completionPatchForRow({
    dueDate: FIELD_READERS.dueDate(fm),
    recurrence: FIELD_READERS.recurrence(fm),
    recurrenceMode: FIELD_READERS.recurrenceMode(fm),
    recurrenceAnchor: FIELD_READERS.recurrenceAnchor(fm),
  }, now);
}

/** A patch that completes a task (`{ completed: true }`) or rolls a recurring one forward. */
function isCompletionPatch(patch: Record<string, unknown>): boolean {
  return patch.completed === true || (patch.completed === false && 'dueDate' in patch);
}

/**
 * The frontmatter patch for setting or clearing a task's recurrence. The
 * anchor belongs to the old rule, so it is unset in the same delta (an empty
 * value deletes the key).
 */
export function recurrenceChangePatch(recurrence: string): Record<string, unknown> {
  return { recurrence, recurrenceAnchor: '' };
}

/**
 * The patch for what a repeat's next date counts from. Schedule (the due
 * date) is the default, so it is written by removing the key; the anchor
 * belongs to schedule mode's month steps and goes with a change either way.
 */
export function recurrenceModePatch(mode: RecurrenceMode): Record<string, unknown> {
  return { recurrenceMode: mode === 'completion' ? 'completion' : '', recurrenceAnchor: '' };
}

/**
 * The warning a Complete owes when the task's rule can't be read: it is
 * marked done, and won't come back. Undo (while it is the board's last step)
 * puts it back.
 */
export function warnUnreadableRules(count: number, rule: string, undo: () => boolean): void {
  if (count === 0) return;
  uiStore.pushToast({
    text: count === 1
      ? `Marked done, and it won't repeat: Filo can't read its repeat rule "${rule}". Pick a rule in Repeat to keep it repeating.`
      : `Marked done, and ${count} of them won't repeat: Filo can't read their repeat rules.`,
    type: 'warning',
    duration: 8000,
    actions: [{
      label: 'Undo',
      handler: () => {
        if (!undo()) uiStore.toast('Couldn\'t undo: other changes were made since. Use Undo (Ctrl+Z) to step back.', 'info', 5000);
      },
    }],
  });
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
  setRecurrenceMode(row: TaskRow, mode: RecurrenceMode): Promise<void>;
  cyclePriority(row: TaskRow): Promise<void>;
  setDueDate(row: TaskRow, dueDate: string): Promise<void>;
  setDueTime(row: TaskRow, dueTime: string): Promise<void>;
  setStartDate(row: TaskRow, startDate: string): Promise<void>;
  setNotesBody(row: TaskRow, body: string): Promise<SetBodyStatus>;
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
    //
    // A completion is decided again from the note as it stands when the
    // command runs: the row may show a task whose note hasn't loaded yet (no
    // recurrence), and completing a recurring task must roll it forward.
    const completion = isCompletionPatch(patch);
    const atomic = completion || ('completed' in patch && 'dueDate' in patch);
    return new UpdateTaskFieldCommand(
      board.id, path, patch, inverse, description, atomic,
      completion ? (fm) => completionPatchForFrontmatter(fm) : null,
    );
  }

  /** Runs the row's field change; returns the change as made (null: none) and its step. */
  async function runRowField(
    row: TaskRow,
    patch: Record<string, unknown>,
  ): Promise<{ applied: Record<string, unknown>; cmd: UpdateTaskFieldCommand } | null> {
    const board = getBoard();
    if (!board) return null;
    const cmd = buildTaskFieldCommand(row, patch);
    // Await the command so this resolves once the change is queued and shows
    // on the row; the chain reports its own errors, so swallow the rejection
    // on this fire-and-forget UI path.
    const ok = cmd ? await historyStore.execute(cmd).then(() => true, () => false) : false;
    bumpCacheVersion();
    return ok && cmd ? { applied: cmd.forwardDelta.set, cmd } : null;
  }

  async function updateRowField(row: TaskRow, patch: Record<string, unknown>): Promise<void> {
    await runRowField(row, patch);
  }

  function setRecurrenceMode(row: TaskRow, mode: RecurrenceMode): Promise<void> {
    if (mode === row.recurrenceMode) return Promise.resolve();
    return updateRowField(row, recurrenceModePatch(mode));
  }

  async function toggleCompleted(row: TaskRow): Promise<void> {
    // Completing routes through the shared `completionPatchForRow` so the
    // recurrence roll-forward stays identical to the bulk path (the command
    // decides it again from the note). Un-completing is a plain
    // `completed: false`.
    const boardId = getBoard()?.id ?? null;
    const ran = await runRowField(row, row.completed ? { completed: false } : completionPatchForRow(row));
    const applied = ran?.applied;
    // A recurring roll-forward keeps completed:false and advances the due
    // date, so the checkbox just snaps back with no other signal. Announce the new
    // date so the reschedule is visible.
    if (!row.completed && applied?.completed === false && typeof applied.dueDate === 'string') {
      uiStore.toast(`Recurring task rescheduled to ${formatDay(applied.dueDate)}`, 'info', 2500);
    }
    // A rule Filo can't read can't roll forward: the task is done for good,
    // which a checkbox alone wouldn't say.
    if (ran && !row.completed && applied?.completed === true && row.recurrence && !parseRecurrence(row.recurrence)) {
      warnUnreadableRules(1, row.recurrence, () => historyStore.undoIfLatest(ran.cmd, boardId));
    }
  }

  function setRecurrence(row: TaskRow, recurrence: string): Promise<void> {
    // Clearing recurrence intentionally leaves `recurrenceMode` in place so
    // a later re-add picks up the user's last-chosen mode.
    return updateRowField(row, recurrenceChangePatch(recurrence));
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

  /**
   * The notes box: sets the task note's body (a row with no note has none).
   * Anything but `queued` means the body wasn't taken; the box keeps it.
   */
  async function setNotesBody(row: TaskRow, body: string): Promise<SetBodyStatus> {
    const path = resolveTextTileVaultPath(row.tile);
    const status = path ? await noteStore.writeBody(path, body) : 'not-open';
    bumpCacheVersion();
    return status;
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
    setRecurrenceMode,
    cyclePriority,
    setDueDate,
    setDueTime,
    setStartDate,
    setNotesBody,
    markAllIncomplete,
  };
}
