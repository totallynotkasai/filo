import type {
  TaskListBoard as TaskListBoardType,
  TaskListSection,
  TaskPlacement,
  TileDefinition,
} from '../../schema/index';
import { defaultTileStyleSnapshot } from '../../constants/defaults';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { noteStore } from '../../stores/notes.svelte';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { fileTagsStore } from '../../stores/fileTags.svelte';
import { AddTaskCommand } from '../../commands/index';
import type { SeededFile } from '../../commands/taskCommands';
import { createId } from '../utils/ids';
import { newNoteText } from '../notes/noteFile';
import { noteTitle } from '../../stores/noteMeta';
import { reportError } from '../utils/errorBus';
import { sectionIdForPlacementIndex } from './sectionMath';
import { getTaskDepth, subtaskInsertIndex } from './blockMove';
import {
  fileNameSafe,
  getActiveContentFolder,
  nextFreeMdPath as nextFreeMdPathLib,
} from '../vault/conventionPaths';
import type { QuickAddParsed } from '../tasks/quickAddParser';
import type { TaskRow } from '../tasks/taskListModel';

/**
 * Task-creation slice for TaskListBoard. Owns the side-effecting flow that
 * combines a new `TileDefinition`, a default-or-quick-add `.md` seed on
 * disk, document-store hydration, and the `AddTaskCommand` dispatch.
 * Factory closes over reactive accessors so the extracted helpers always
 * see the live board / sections / rows state without capturing stale
 * snapshots. Mirrors `kanbanTileCreation.ts`.
 */

/** A new task's tile style. No font sizes: the task follows the task cascade. */
function buildBaseTileStyle() {
  return defaultTileStyleSnapshot();
}

export interface TaskCreationDeps {
  getBoard: () => TaskListBoardType | null;
  getSections: () => TaskListSection[];
  getPlacements: () => TaskPlacement[];
  getRows: () => TaskRow[];
  getCollapsedSubtasks: () => Set<string>;
  getLastTargetedSectionId: () => string | null;
  setLastTargetedSectionId: (next: string | null) => void;
  ensureDefaultSectionMaterialized: () => string | null;
  persistCollapsedSubtasks: (next: Set<string>) => void;
  tickAndPersist: () => void;
  announce: (message: string) => void;
  defaultSectionId: string;
}

export interface TaskCreator {
  nextDefaultTitle(): string;
  nextSubtaskTitle(parentTileId: string): string;
  endOfSectionIndex(sectionId: string | null): number;
  addTask(): Promise<void>;
  addTaskToSection(sectionId: string | null): Promise<void>;
  addTaskFromQuickAdd(parsed: QuickAddParsed, targetSectionId?: string | null): Promise<void>;
  addSubtaskFor(parentTileId: string): Promise<void>;
}

interface SeedFileArgs {
  relPath: string;
  title: string;
  folder: string;
  fm: Record<string, unknown> | null;
}

export function makeTaskCreator(deps: TaskCreationDeps): TaskCreator {
  const {
    getBoard,
    getSections,
    getPlacements,
    getRows,
    getCollapsedSubtasks,
    getLastTargetedSectionId,
    setLastTargetedSectionId,
    ensureDefaultSectionMaterialized,
    persistCollapsedSubtasks,
    tickAndPersist,
    announce,
    defaultSectionId,
  } = deps;

  function collectExistingTextTitles(): Set<string> {
    const taken = new Set<string>();
    for (const data of Object.values(boardCacheStore.cache)) {
      for (const def of Object.values(data.tileDefs)) {
        if (def.type === 'text') taken.add(noteTitle(def.filePath));
      }
    }
    return taken;
  }

  function nextDefaultTitle(): string {
    const taken = collectExistingTextTitles();
    if (!taken.has('New Task')) return 'New Task';
    let n = 2;
    while (taken.has(`New Task ${n}`)) n++;
    return `New Task ${n}`;
  }

  function nextSubtaskTitle(parentTileId: string): string {
    const rows = getRows();
    const parentRow = rows.find((r) => r.tile.id === parentTileId);
    const parentTitle = (parentRow?.tile.title ?? '').trim() || 'Task';
    const taken = collectExistingTextTitles();
    let n = 1;
    let candidate = `${parentTitle} - Subtask ${n}`;
    while (taken.has(candidate)) {
      n++;
      candidate = `${parentTitle} - Subtask ${n}`;
    }
    return candidate;
  }

  // Append-to-end-of-section index. `null` => leading "Unsectioned" bucket
  // (just before the first persisted section).
  function endOfSectionIndex(sectionId: string | null): number {
    const sections = getSections();
    const placements = getPlacements();
    const sortedLive = [...sections].sort((a, b) => a.position - b.position);
    if (sectionId === null) {
      return sortedLive[0]?.position ?? placements.length;
    }
    const idx = sortedLive.findIndex((s) => s.id === sectionId);
    if (idx < 0) return placements.length;
    return sortedLive[idx + 1]?.position ?? placements.length;
  }

  // Shared seed routine: writes the `.md` (with `title:` first) and warms the
  // vault index so the row builder doesn't lag the watcher. Resolves the path
  // it ACTUALLY created (the create is exclusive and bumps to ` (n)` if the
  // pre-pick exists).
  async function seedMdFile(args: SeedFileArgs, kindForError: string): Promise<SeededFile | void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    const { title } = args;
    const fm: Record<string, unknown> = { title, ...(args.fm ?? { completed: false }) };
    const seedFile = newNoteText(fm, '');
    // The backing `.md` write is CRITICAL: let a failure PROPAGATE so the
    // chained `AddTaskCommand.execute()` rolls its placement back (no orphan
    // board row referencing a missing file). The helper routes the failure
    // through the save-error pipeline before rethrowing. Create-EXCLUSIVE: an
    // existing off-board file with the same name is never overwritten.
    const created = await noteStore.createUnique(args.relPath, () => seedFile);
    const relPath = created.relPath;
    // Post-write hydration is best-effort — the file IS on disk now, so the row
    // is valid; a lagging index / doc-load just hydrates lazily on the next edit.
    // A failure here must NOT roll the placement back (hence its own try/catch).
    try {
      // Pre-warm the vault index so the row builder (which sources fields
      // via vaultIndexStore) doesn't lag behind the watcher debounce.
      await vaultIndexStore.applyChanges([relPath]);
    } catch (err) {
      reportError(
        'tasklist.seed-md',
        err,
        `Backing file for "${title}" (${kindForError}) was created, but post-write setup lagged — it should recover on the next edit`,
      );
    }
    return { relPath, title };
  }

  function buildTaskDef(args: {
    title: string;
    folder: string;
  }): { def: TileDefinition; relPath: string; title: string } {
    const now = Date.now();
    // Bake `filePath` into the def HERE, before AddTaskCommand's ctor
    // deep-clones it — stamping later would mutate an object the cache never
    // sees. The seed may still bump the name; the command re-stamps then.
    const relPath = nextFreeMdPathLib(boardCacheStore.cache, args.folder, fileNameSafe(args.title));
    const def: TileDefinition = {
      id: createId(),
      type: 'text',
      style: buildBaseTileStyle(),
      createdAt: now,
      updatedAt: now,
      filePath: relPath,
    };
    return { def, relPath, title: args.title };
  }

  // Carries the stable target section id across the async seed window;
  // recomputes the placement index *after* the await so concurrent task
  // creations (or a watcher-driven reload) can't shift the insert slot out
  // from under us. Threads `targetSectionId` into the command so
  // persistAddTaskPlacement can pin the section the task belongs to even
  // when multiple sections share the same `position` (empty tail
  // sections, adjacent empty sections in the middle of the list).
  async function createTaskInSection(targetSectionId: string | null): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const folder = getActiveContentFolder(board);
    const { def, relPath, title } = buildTaskDef({ title: nextDefaultTitle(), folder });
    // The `.md` seed is folded INTO AddTaskCommand.execute() (its last
    // argument), which persists the placement synchronously FIRST and then
    // awaits the seed — all on the history chain, so save()/quit cover the seed
    // via whenChainSettled() (no orphan row with lost metadata). On a seed-write
    // failure the command rolls its placement back. Placement-first also keeps
    // the insertPos TOCTOU tight.
    const insertPos = endOfSectionIndex(targetSectionId);
    // Gate the success announcement on the chain resolving (a failed seed
    // rolls the placement back). The failure announcement gives SR users parity
    // with the visual error toast.
    const cmd = new AddTaskCommand(board.id, def, insertPos, undefined, targetSectionId ?? undefined, () =>
      seedMdFile({ relPath, title, folder, fm: null }, 'new task'),
    );
    const ok = await historyStore.execute(cmd).then(() => true, () => false);
    tickAndPersist();
    if (ok) announce(`Task added: ${cmd.currentTitle}`);
    else announce(`Adding task failed: ${title} — see the error notification`);
  }

  async function addTaskToSection(sectionId: string | null): Promise<void> {
    if (!getBoard()) return;
    let realTargetId: string | null = sectionId;
    if (sectionId === defaultSectionId) {
      realTargetId = ensureDefaultSectionMaterialized();
    }
    await createTaskInSection(realTargetId);
    if (realTargetId) setLastTargetedSectionId(realTargetId);
  }

  async function addTask(): Promise<void> {
    if (!getBoard()) return;
    const sections = getSections();
    // `lastTargetedSectionId` is set only by an explicit add-to-section
    // gesture (footer "Add task", bulk move). When that's still valid, use
    // it. Otherwise fall back to the FIRST persisted section — most users
    // expect quick-add buttons to land at the top of the list, not the
    // bottom.
    let target: string | null = getLastTargetedSectionId();
    if (target && !sections.some((s) => s.id === target)) target = null;
    if (!target) {
      const sortedLive = [...sections].sort((a, b) => a.position - b.position);
      target = sortedLive[0]?.id ?? defaultSectionId;
    }
    await addTaskToSection(target);
  }

  async function addTaskFromQuickAdd(
    parsed: QuickAddParsed,
    targetSectionId: string | null = null,
  ): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const title = parsed.title.trim();
    if (!title) return;

    const folder = getActiveContentFolder(board);
    const { def, relPath } = buildTaskDef({ title, folder });

    const fm: Record<string, unknown> = { completed: false };
    if (parsed.priority) fm.priority = parsed.priority;
    if (parsed.dueDate) fm.dueDate = parsed.dueDate;
    if (parsed.dueTime) fm.dueTime = parsed.dueTime;
    if (parsed.startDate) fm.startDate = parsed.startDate;
    if (parsed.status) fm.status = parsed.status;
    if (parsed.tags.length > 0) fm.tags = [...parsed.tags];
    // Registered as the tag row registers what it adds, so the Tags browser
    // (and a rename's merge check) knows them before the index reads the note.
    for (const tag of parsed.tags) fileTagsStore.ensureTag(tag);

    // Materialise the default section *before* the await so we carry a real
    // section id across the seed; the index itself is recomputed afterwards
    // (same TOCTOU fix as createTaskInSection).
    let resolvedTargetId: string | null = null;
    if (targetSectionId) {
      resolvedTargetId = targetSectionId === defaultSectionId
        ? ensureDefaultSectionMaterialized()
        : targetSectionId;
    }

    // Compute the insert slot here, then fold the `.md` seed INTO
    // AddTaskCommand.execute() so placement and seed both run on the history
    // chain that quit drains. See createTaskInSection.
    const placementsNow = getPlacements();
    let insertPos = placementsNow.length;
    if (resolvedTargetId) {
      const sectionsNow = getSections();
      const sortedLive = [...sectionsNow].sort((a, b) => a.position - b.position);
      const idx = sortedLive.findIndex((s) => s.id === resolvedTargetId);
      if (idx >= 0) {
        insertPos = sortedLive[idx + 1]?.position ?? placementsNow.length;
      }
    }

    // Success announcement gated on the chain resolving (see createTaskInSection).
    const cmd = new AddTaskCommand(board.id, def, insertPos, undefined, resolvedTargetId ?? undefined, () =>
      seedMdFile({ relPath, title, folder, fm }, 'quick-add task'),
    );
    const ok = await historyStore.execute(cmd).then(() => true, () => false);
    tickAndPersist();
    if (resolvedTargetId) setLastTargetedSectionId(resolvedTargetId);
    if (ok) announce(`Task added from quick add: ${cmd.currentTitle}`);
    else announce(`Adding task failed: ${title} — see the error notification`);
  }

  async function addSubtaskFor(parentTileId: string): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const rows = getRows();
    const collapsedSubtasks = getCollapsedSubtasks();
    // 3-level cap on parent depth.
    if (getTaskDepth(rows, parentTileId) >= 2) {
      uiStore.toast('Maximum subtask depth reached', 'info', 2000);
      return;
    }
    const folder = getActiveContentFolder(board);
    const { def, relPath, title } = buildTaskDef({ title: nextSubtaskTitle(parentTileId), folder });

    // The parent is recorded on the placement (board structure), not in the note.
    const fm: Record<string, unknown> = { completed: false };

    // Compute the parent index here, then fold the `.md` seed INTO
    // AddTaskCommand.execute() so placement and seed both ride the history chain
    // that quit drains. Reading the live placements here pins our slot before
    // any sibling creation/reload can run. Falling back to end-of-list covers a
    // parent deleted mid-flight.
    const placementsNow = getPlacements();
    const sectionsNow = getSections();
    const parentIdx = placementsNow.findIndex((p) => p.tileId === parentTileId);
    const insertAt = subtaskInsertIndex(rows, placementsNow, sectionsNow, parentTileId);
    const parentSection = parentIdx >= 0 ? sectionIdForPlacementIndex(sectionsNow, parentIdx) : null;
    // Success announcement gated on the chain resolving (see createTaskInSection).
    const cmd = new AddTaskCommand(board.id, def, insertAt, undefined, parentSection ?? undefined, () =>
      seedMdFile({ relPath, title, folder, fm }, 'subtask'), parentTileId,
    );
    const ok = await historyStore.execute(cmd).then(() => true, () => false);

    if (collapsedSubtasks.has(parentTileId)) {
      const next = new Set(collapsedSubtasks);
      next.delete(parentTileId);
      persistCollapsedSubtasks(next);
    }

    if (parentSection) setLastTargetedSectionId(parentSection);

    tickAndPersist();
    if (ok) announce(`Subtask added: ${cmd.currentTitle}`);
    else announce(`Adding subtask failed: ${title} — see the error notification`);
  }

  return {
    nextDefaultTitle,
    nextSubtaskTitle,
    endOfSectionIndex,
    addTask,
    addTaskToSection,
    addTaskFromQuickAdd,
    addSubtaskFor,
  };
}
