import type {
  TaskListBoard as TaskListBoardType,
  Tile,
} from '../../schema/index';
import { documentStore } from '../../stores/document.svelte';
import { historyStore } from '../../stores/history.svelte';
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
    return new UpdateTaskFieldCommand(board.id, path, docId, patch, inverse, description);
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
    // Recurring tasks don't "complete" — they roll forward. Computing the
    // next instance from the live row (current due + recurrence + mode) and
    // writing it back keeps `completed: false` while advancing the due date.
    if (!row.completed && row.recurrence) {
      const next = nextDueDate(
        row.dueDate || undefined,
        row.recurrence,
        row.recurrenceMode,
        new Date(),
      );
      if (next) {
        await updateRowField(row, { completed: false, dueDate: next });
        return;
      }
    }
    await updateRowField(row, { completed: !row.completed });
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
      documentStore.updateContent(docId, after?.htmlContent ?? '', body);
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
    }
    // Arm (or, for the docId path, re-arm) the write once FM is seeded. It
    // coalesces with the early A8-M3(a) schedule above (resetting the 300 ms
    // timer to the same path). The re-arm also closes the narrow first-touch
    // window where a `flushAll` raced the gated seed and fired the early timer
    // against a still-EMPTY FM cache: `writeFrontmatter`'s `if (!fm) return`
    // makes that fire a no-op AND consume the timer, so without this second arm
    // the body — already live in the cache — would never get written once FM
    // finally seeded. (`scheduleFrontmatterWrite` reads body + FM live at fire.)
    scheduleFrontmatterWrite(path, docId);
    bumpCacheVersion();
  }

  async function markAllIncomplete(rows: TaskRow[]): Promise<void> {
    if (!getBoard()) return;
    const cmds: UpdateTaskFieldCommand[] = [];
    for (const r of rows) {
      if (!r.completed) continue;
      // Audit-7 H1 — each row's disk pre-seed moved INTO UpdateTaskFieldCommand.
      // execute(); BatchCommand awaits its children's execute() in order, so the
      // seeds + writes all run on the history chain that save()/quit drain.
      const cmd = buildTaskFieldCommand(r, { completed: false }, 'Mark incomplete');
      if (cmd) cmds.push(cmd);
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
