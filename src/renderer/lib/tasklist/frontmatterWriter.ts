import type {
  TaskListBoard as TaskListBoardType,
  Tile,
} from '../../schema/index';
import { documentStore } from '../../stores/document.svelte';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import {
  BatchCommand,
  UpdateTaskFieldCommand,
} from '../../commands/index';
import {
  scheduleFrontmatterWrite as scheduleSharedFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
} from '../boards/frontmatterWriteScheduler';
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
  updateRowField(row: TaskRow, patch: Record<string, unknown>): void;
  toggleCompleted(row: TaskRow): void;
  setRecurrence(row: TaskRow, recurrence: string): void;
  cyclePriority(row: TaskRow): void;
  setDueDate(row: TaskRow, dueDate: string): void;
  setDueTime(row: TaskRow, dueTime: string): void;
  setStartDate(row: TaskRow, startDate: string): void;
  setNotesBody(row: TaskRow, body: string): void;
  markAllIncomplete(rows: TaskRow[]): void;
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
    const docId = ensureSeededFm(row.tile);
    // 6.2.H7 — UpdateTaskFieldCommand now throws on null docId (it was a
    // silent no-op pre-fix). Short-circuit here so the caller's fallback
    // branch (extremely rare, pre-live-cache tiles) takes over.
    if (!docId) return null;
    const before = readFrontmatter(row.tile);
    const inverse: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      // mergeFrontmatter's cleaning rule deletes empty/null/undefined values,
      // so absent previous keys map to '' (which restores the absent state).
      inverse[key] = key in before ? before[key] : '';
    }
    return new UpdateTaskFieldCommand(board.id, path, docId, patch, inverse, description);
  }

  function updateRowField(row: TaskRow, patch: Record<string, unknown>): void {
    if (!getBoard()) return;
    const cmd = buildTaskFieldCommand(row, patch);
    if (cmd) {
      historyStore.execute(cmd);
    } else {
      // Fallback for tiles without a docId — extremely rare (predates the
      // shared live cache). Preserves prior best-effort behaviour.
      const path = vaultPathForTile(row.tile);
      const docId = ensureSeededFm(row.tile);
      if (docId) documentStore.mergeFrontmatter(docId, patch);
      scheduleFrontmatterWrite(path, docId);
    }
    bumpCacheVersion();
  }

  function toggleCompleted(row: TaskRow): void {
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
        updateRowField(row, { completed: false, dueDate: next });
        return;
      }
    }
    updateRowField(row, { completed: !row.completed });
  }

  function setRecurrence(row: TaskRow, recurrence: string): void {
    // Clearing recurrence intentionally leaves `recurrenceMode` in place so
    // a later re-add picks up the user's last-chosen mode.
    updateRowField(row, { recurrence });
  }

  function cyclePriority(row: TaskRow): void {
    const order: Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];
    const next = order[(order.indexOf(row.priority) + 1) % order.length];
    updateRowField(row, { priority: next === 'none' ? '' : next });
  }

  function setDueDate(row: TaskRow, dueDate: string): void {
    updateRowField(row, { dueDate });
  }

  function setDueTime(row: TaskRow, dueTime: string): void {
    updateRowField(row, { dueTime });
  }

  function setStartDate(row: TaskRow, startDate: string): void {
    updateRowField(row, { startDate });
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
  function setNotesBody(row: TaskRow, body: string): void {
    const path = vaultPathForTile(row.tile);
    const t = row.tile as Tile & { contentId?: string };
    const docId = t.contentId ?? null;
    if (docId) {
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
      ensureSeededFm(row.tile);
    }
    scheduleFrontmatterWrite(path, docId);
    bumpCacheVersion();
  }

  function markAllIncomplete(rows: TaskRow[]): void {
    if (!getBoard()) return;
    const cmds: UpdateTaskFieldCommand[] = [];
    for (const r of rows) {
      if (!r.completed) continue;
      const cmd = buildTaskFieldCommand(r, { completed: false }, 'Mark incomplete');
      if (cmd) cmds.push(cmd);
    }
    if (cmds.length === 0) {
      uiStore.toast('No completed tasks to mark', 'info', 2000);
      return;
    }
    historyStore.execute(new BatchCommand(`Mark ${cmds.length} tasks incomplete`, cmds));
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
