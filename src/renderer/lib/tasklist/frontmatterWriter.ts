import type {
  TaskListBoard as TaskListBoardType,
  Tile,
} from '../../schema/index';
import { documentStore } from '../../stores/document.svelte';
import { historyStore, type Command } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import {
  BatchCommand,
  UpdateOrphanFrontmatterCommand,
  UpdateTaskFieldCommand,
} from '../../commands/index';
import {
  scheduleFrontmatterWrite as scheduleSharedFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
} from '../boards/frontmatterWriteScheduler';
import { seedDocumentFrontmatterFromDisk } from '../boards/seedFrontmatterFromDisk';
import { assembleMarkdownFile } from '../editor/markdownSync';
import { readMarkdownForHydrate } from '../vault/markdownFileWriter';
import { writeMarkdownAndReconcile } from '../vault/syncOpenEditorsAfterDiskMutation';
import { nextDueDate } from '../tasks/recurrence';
import type { Priority } from '../tasks/frontmatterReaders';
import type { TaskRow } from '../tasks/taskListModel';

/**
 * Frontmatter-writer slice for TaskListBoard.
 *
 * Frontmatter lives in the documentStore live cache, shared with TextTile /
 * DocumentEditor / PropertiesPopup. All four writers pull their FM from
 * there at write time, so a write from any single owner can't silently
 * revert another's concurrent edit. The cache is seeded lazily from
 * vaultIndexStore the first time a task is touched; mutations go through
 * `documentStore.mergeFrontmatter`; the actual debounced disk write is
 * owned by `lib/boards/frontmatterWriteScheduler`, shared between
 * TaskListBoard / KanbanBoard / undo-redo Commands.
 *
 * Mirrors `kanbanFrontmatterWriter.ts`. Factory closes over reactive
 * accessors (board, vaultPathForTile, bumpCacheVersion) so writers always
 * see the live host state.
 */

// Re-export so the host can register the shared flusher via this module.
export { flushAllPendingFrontmatterWrites };

/**
 * Computes the frontmatter patch for marking a single (currently incomplete)
 * row complete. A recurring task does NOT complete — it rolls forward: the
 * next instance's due date is computed from the live row (current due +
 * recurrence + mode) and written back, keeping `completed: false`.
 *
 * REC-1 — schedule mode needs an anchor `dueDate`; without one `nextDueDate`
 * returns null. Rather than silently terminating the recurrence (the old
 * behaviour — falling through to a plain completion, so an undated repeating
 * task got permanently completed and never recurred again, AND schedule is the
 * DEFAULT mode), we seed the next instance from the completion day
 * (completion-mode semantics) so the task keeps recurring. Only a genuinely
 * unparseable `recurrence` string (both modes return null) falls back to a
 * plain completion.
 *
 * Shared by the single-row `toggleCompleted` and the bulk
 * `multiSelectController.bulkMarkComplete` so the two "mark complete" paths
 * can't silently diverge (BULK-1 — the bulk path used to stamp
 * `{ completed: true }` with NO recurrence branch, permanently completing
 * repeating tasks).
 *
 * Pure given `now`; defaults to the current time for production callers.
 */
export function completionPatchForRow(
  row: TaskRow,
  now: Date = new Date(),
): Record<string, unknown> {
  if (row.recurrence) {
    let next = nextDueDate(row.dueDate || undefined, row.recurrence, row.recurrenceMode, now);
    // REC-1 — schedule mode with no anchor date returns null; fall back to
    // completion-mode (next = completion day + interval) so recurrence survives.
    if (!next && row.recurrenceMode !== 'completion') {
      next = nextDueDate(row.dueDate || undefined, row.recurrence, 'completion', now);
    }
    if (next) return { completed: false, dueDate: next };
  }
  return { completed: true };
}

/**
 * NOTES-1 — write a docId-less task's notes body directly to disk, preserving
 * its frontmatter source byte-for-byte. Reads FM+body fresh (so an external FM
 * edit isn't clobbered), swaps the body for `body`, and routes through the
 * coupled write+reconcile gateway helper, which loud-fails on a write error
 * (toast + `.filo/.dirty` sentinel via `trackComponentWrite`). Module-level: it
 * needs no host deps. A read failure assembles a body-only file (a fresh/missing
 * file has no frontmatter to lose).
 */
async function writeOrphanNotesBody(path: string, body: string): Promise<void> {
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  let frontmatter: Record<string, unknown> = {};
  let rawFrontmatter: string | undefined;
  let bom = false;
  let eol: '\r\n' | '\n' = '\n';
  try {
    // Same canonical orphan-read the docId-less Kanban/Task FM path uses
    // (applyOrphanPatchRebased) — parses FM + body and seeds the drift baseline.
    const hydrate = await readMarkdownForHydrate(vaultRoot, path);
    frontmatter = hydrate.frontmatter;
    rawFrontmatter = hydrate.rawFrontmatter;
    bom = hydrate.hadBom;
    eol = hydrate.content.includes('\r\n') ? '\r\n' : '\n';
  } catch {
    // ENOENT / transient — assemble a body-only file (no FM to lose / preserve).
  }
  const fileText = assembleMarkdownFile(frontmatter, body, {
    rawFrontmatter,
    frontmatterDirty: false, // body-only change — emit the FM source verbatim
    bom,
    eol,
  });
  await writeMarkdownAndReconcile({ vaultRoot, path, content: fileText, mode: 'full', create: false });
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
}

export interface FrontmatterWriter {
  ensureSeededFm(tile: Tile): string | null;
  scheduleFrontmatterWrite(relPath: string, docId: string | null): void;
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
  const { getBoard, vaultPathForTile, readFrontmatter, bumpCacheVersion } = deps;

  /** Returns the tile's docId; seeds the FM cache from the vault index on first touch. */
  function ensureSeededFm(tile: Tile): string | null {
    const docId = (tile as Tile & { contentId?: string }).contentId ?? null;
    if (docId && !documentStore.getFrontmatter(docId)) {
      documentStore.setFrontmatter(docId, readFrontmatter(tile));
    }
    return docId;
  }

  function scheduleFrontmatterWrite(relPath: string, docId: string | null): void {
    scheduleSharedFrontmatterWrite(relPath, docId);
  }

  /**
   * Builds a single UpdateTaskFieldCommand for a row's frontmatter patch.
   * Captures the inverse patch (previous values for each affected key) so
   * undo restores the exact prior state. Returns `null` when the tile has
   * no docId — that case predates the live-cache architecture and is rare.
   */
  function buildTaskFieldCommand(
    row: TaskRow,
    patch: Record<string, unknown>,
    description?: string,
  ): UpdateTaskFieldCommand | null {
    const board = getBoard();
    if (!board) return null;
    const path = vaultPathForTile(row.tile);
    // Resolve the docId WITHOUT seeding (Audit-7 H1): the disk pre-seed moved
    // INTO UpdateTaskFieldCommand.execute(), and a sync index-seed here would
    // populate the cache first, making that disk seed a no-op. The command's
    // execute() now seeds (disk, then index fallback) on the history chain.
    const docId = (row.tile as Tile & { contentId?: string }).contentId ?? null;
    // 6.2.H7 — UpdateTaskFieldCommand now throws on null docId (it was a
    // silent no-op pre-fix). Short-circuit here so the caller's fallback
    // branch (extremely rare, pre-live-cache tiles) takes over.
    if (!docId) return null;
    // Best-effort inverse from the vault index; the command recomputes it from
    // the fresh disk read on execute so undo restores the TRUE prior value.
    const before = readFrontmatter(row.tile);
    const inverse: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      // mergeFrontmatter's cleaning rule deletes empty/null/undefined values,
      // so absent previous keys map to '' (which restores the absent state).
      inverse[key] = key in before ? before[key] : '';
    }
    // REC-2 — a patch carrying BOTH `completed` and `dueDate` is, in this code, a
    // recurrence roll-forward: `completionPatchForRow` is the ONLY producer of
    // that shape (every other task field setter — priority, due, start, status,
    // a plain (un)complete — is single-key). Mark it atomic so undo/redo can't
    // split the coupled pair when an external editor touched just one of the two
    // keys in between (which would leave `completed: true` + an advanced due).
    // This chokepoint serves both the single-row (toggleCompleted) and bulk
    // (bulkMarkComplete) paths, since both build commands through here.
    const atomic = 'completed' in patch && 'dueDate' in patch;
    return new UpdateTaskFieldCommand(board.id, path, docId, patch, inverse, description, atomic);
  }

  async function updateRowField(row: TaskRow, patch: Record<string, unknown>): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const cmd = buildTaskFieldCommand(row, patch);
    if (cmd) {
      // Audit-7 H1 — the disk pre-seed moved INTO UpdateTaskFieldCommand.
      // execute() so the read joins the history chain vaultStore.save()/quit
      // await via whenChainSettled(). Await the command so this resolves only
      // after the seed + merge + schedule have run; the chain reports its own
      // errors, so swallow the rejection on this fire-and-forget UI path.
      await historyStore.execute(cmd).catch(() => {});
    } else {
      // A9-L3 — docId-less tile (predates the shared live cache; extremely
      // rare). The previous fallback armed `scheduleFrontmatterWrite(path, null)`,
      // which the scheduler resolves as a SILENT no-op (`if (!fm) return`) when
      // the path is absent from the vault index — dropping the edit with a false
      // SUCCESS that lets markClean wipe `.filo/.dirty`. Route through the orphan
      // command instead (mirrors kanbanFrontmatterWriter's no-contentId branch):
      // it reads body + FM fresh from disk, writes directly via the gateway, is
      // undoable, and loudly fails (A9-L2) on a write error rather than silently
      // no-op'ing. The command recomputes the inverse from the fresh disk read,
      // so this best-effort index inverse is only a construction-time placeholder.
      const path = vaultPathForTile(row.tile);
      const before = readFrontmatter(row.tile);
      const inverse: Record<string, unknown> = {};
      for (const key of Object.keys(patch)) {
        inverse[key] = key in before ? before[key] : '';
      }
      await historyStore
        .execute(
          new UpdateOrphanFrontmatterCommand(
            board.id,
            path,
            patch,
            inverse,
            `Update task ${Object.keys(patch).join(', ')}`,
          ),
        )
        .catch(() => {});
    }
    bumpCacheVersion();
  }

  async function toggleCompleted(row: TaskRow): Promise<void> {
    // Completing routes through the shared `completionPatchForRow` so the
    // recurrence roll-forward stays identical to the bulk path (BULK-1).
    // Un-completing is a plain `completed: false`.
    const patch = row.completed ? { completed: false } : completionPatchForRow(row);
    await updateRowField(row, patch);
    // REC-3 — a recurring roll-forward keeps completed:false and advances the due
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
    // DATE-3 — clearing the due date also clears any dueTime, in ONE command
    // (so a single undo entry, no phantom no-op time-clear). A dangling dueTime
    // with no dueDate is invisible anyway — the chip only renders inside
    // `{#if dueDate}` (DATE-2). A non-empty date leaves the time untouched.
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
   * Notes editor write path: mirrors the frontmatter writer but mutates body
   * instead of frontmatter. The shared trackComponentWrite + assembleMarkdownFile
   * pipeline guarantees FM and body stay round-trippable.
   *
   * documentStore.updateContent overwrites htmlContent, so we read the
   * existing entry first to preserve it. A task whose .md hasn't been
   * opened yet is loaded lazily here, seeded from the vault-index content
   * cache.
   */
  async function setNotesBody(row: TaskRow, body: string): Promise<void> {
    const path = vaultPathForTile(row.tile);
    const t = row.tile as Tile & { contentId?: string };
    const docId = t.contentId ?? null;
    if (docId) {
      // A8-M3(a) — apply the NEW body into the live cache and ARM the write
      // BEFORE awaiting the disk-FM seed. `seedDocumentFrontmatterFromDisk` is
      // an IPC read; a quit landing in that await window used to resolve
      // `whenChainSettled()` against an empty chain (no write scheduled yet) and
      // drop the typed notes with a clean `.filo/.dirty` sentinel. `loadDocument`
      // and `updateContent` never touch the FM cache, so doing them first is FM-
      // safe; `scheduleFrontmatterWrite` reads the body + FM live at fire time
      // (normally 300 ms later, long after the seed has refreshed FM), so the
      // armed timer captures the latest body regardless of how it interleaves
      // with the seed.
      const existing = documentStore.getDocument(docId);
      if (!existing) {
        const meta = vaultIndexStore.getMetadata(path);
        documentStore.loadDocument({
          docId,
          filename: path,
          title: row.tile.title,
          body: meta?.content ?? '',
          htmlContent: '',
          richText: [],
        });
      }
      const after = documentStore.getDocument(docId);
      // NOTES-2 — register a writerId so a sibling DocumentEditor's per-writer
      // markClean can't flip this doc's `isDirty` off while the typed note is
      // still unsaved. The id MATCHES the frontmatter scheduler's gateway
      // callerId (`frontmatter-scheduler:${path}`), so the notes write's OWN
      // success (`markClean(docId, callerId)`) clears it — no pinned-dirty risk.
      documentStore.updateContent(docId, after?.htmlContent ?? '', body, `frontmatter-scheduler:${path}`);
      // A9-M2 (Audit-9) — seed the FM cache SYNCHRONOUSLY (from the vault index)
      // BEFORE the early arm. The early-armed write can be drained by a quit's
      // flushAll DURING the disk read below; with an EMPTY FM cache that drain
      // hits writeFrontmatter's `if (!fm) return` — a no-op that resolves the
      // write as SUCCESS → endWrite(true) → markClean wipes `.filo/.dirty`, so the
      // typed notes are silently dropped (unrecoverable: `.board.json` does not
      // cache the body). An empty index still seeds `{}` (truthy), which is enough
      // to clear the no-op so the drain writes the body. `setNotesBody` makes NO
      // frontmatter mutation, so the disk refresh below safely OVERWRITES this
      // index placeholder (restoring the source-preserving baseline + any
      // externally-added key the index lacked).
      let placeholderVersion: number | undefined;
      if (!documentStore.getFrontmatter(docId)) {
        documentStore.setFrontmatter(
          docId,
          (vaultIndexStore.getMetadata(path)?.frontmatter ?? {}) as Record<string, unknown>,
        );
        placeholderVersion = documentStore.getFrontmatterMutationVersion(docId);
      }
      scheduleFrontmatterWrite(path, docId);
      // Audit-6 M4 — refresh FM from a fresh disk read so the eventual write
      // assembles over the latest disk frontmatter (doesn't drop an externally-
      // added key) AND restores the source-preserving baseline the index
      // placeholder above lacks. In refresh mode the disk bytes OVERWRITE the
      // placeholder, but ONLY if nothing mutated FM since it was seeded (A9-M2 —
      // a racing field edit bumps the version and is preserved). Vault-identity-
      // guarded inside the primitive (A9-M1). Awaited AFTER the schedule, so the
      // pending path is already in the flush/sentinel set when the await suspends.
      await seedDocumentFrontmatterFromDisk(
        docId,
        vaultStore.path,
        path,
        placeholderVersion !== undefined ? { refreshSeedVersion: placeholderVersion } : undefined,
      );
      ensureSeededFm(row.tile);
      // Re-arm the write once FM is seeded. It coalesces with the early
      // A8-M3(a) schedule above (resetting the 300 ms timer to the same path).
      // The re-arm also closes the narrow first-touch window where a `flushAll`
      // raced the gated seed and fired the early timer against a still-EMPTY FM
      // cache: `writeFrontmatter`'s `if (!fm) return` makes that fire a no-op AND
      // consume the timer, so without this second arm the body — already live in
      // the cache — would never get written once FM finally seeded.
      // (`scheduleFrontmatterWrite` reads body + FM live at fire.)
      scheduleFrontmatterWrite(path, docId);
      bumpCacheVersion();
      return;
    }
    // NOTES-1 — docId-less task (predates the live cache; very rare — every
    // Filo-created/dropped task has a contentId). There is no live document to
    // mutate, so the old code fell through to `scheduleFrontmatterWrite(path,
    // null)`, which the scheduler re-emits as the OLD disk body — silently
    // discarding the typed note (unrecoverable: `.board.json` doesn't cache the
    // body). Do an orphan body write instead (read fresh, swap body, write via
    // the loud-failing gateway helper). The error surface comes from
    // trackComponentWrite; the catch only keeps this fire-and-forget UI path
    // from raising an unhandled rejection.
    await writeOrphanNotesBody(path, body).catch(() => {});
    bumpCacheVersion();
  }

  async function markAllIncomplete(rows: TaskRow[]): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const cmds: Command[] = [];
    for (const r of rows) {
      if (!r.completed) continue;
      // Audit-7 H1 — each row's disk pre-seed moved INTO UpdateTaskFieldCommand.
      // execute(); BatchCommand awaits its children's execute() in order, so the
      // seeds + writes all run on the history chain that save()/quit drain.
      const cmd = buildTaskFieldCommand(r, { completed: false }, 'Mark incomplete');
      if (cmd) {
        cmds.push(cmd);
        continue;
      }
      // WRITE-1 — a docId-less completed task (predates the live cache; very
      // rare). buildTaskFieldCommand returns null for it, and the old loop simply
      // SKIPPED it: the task stayed `completed: true` AND the success toast
      // over-counted (it claimed "N marked incomplete" but counted only the
      // docId-backed rows). Route it through the loud, undoable orphan command
      // (mirrors updateRowField's fallback) so the edit actually lands and the
      // reported count is honest.
      const path = vaultPathForTile(r.tile);
      const before = readFrontmatter(r.tile);
      const inverse: Record<string, unknown> = {
        completed: 'completed' in before ? before.completed : '',
      };
      cmds.push(
        new UpdateOrphanFrontmatterCommand(
          board.id,
          path,
          { completed: false },
          inverse,
          'Mark incomplete',
        ),
      );
    }
    if (cmds.length === 0) {
      uiStore.toast('No completed tasks to mark', 'info', 2000);
      return;
    }
    // Await the batch (Audit-7 H1) so the per-row disk seeds + writes — now
    // inside each child's execute() — finish before the confirmation toast,
    // matching the old per-row `await preSeedRow` timing. The chain reports its
    // own errors; swallow here to keep this fire-and-forget UI path quiet.
    await historyStore
      .execute(new BatchCommand(`Mark ${cmds.length} tasks incomplete`, cmds))
      .catch(() => {});
    bumpCacheVersion();
    uiStore.toast(
      `${cmds.length} task${cmds.length === 1 ? '' : 's'} marked incomplete`,
      'success',
      2000,
    );
  }

  return {
    ensureSeededFm,
    scheduleFrontmatterWrite,
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
