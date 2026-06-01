import type {
  TaskListBoard as TaskListBoardType,
  TaskListSection,
  TaskPlacement,
  TileDefinition,
} from '../../schema/index';
import { defaultTileStyleSnapshot } from '../../constants/defaults';
import { defaultTaskFontSizes } from '../styles/defaultFontSizes';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { documentStore } from '../../stores/document.svelte';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { AddTaskCommand } from '../../commands/index';
import { createId } from '../utils/ids';
import { assembleMarkdownFile } from '../editor/markdownSync';
import { trackComponentWrite } from '../boards/boardSaver';
import { markHydrated } from '../vault/markdownFileWriter';
import { reportError } from '../utils/errorBus';
import { invokeOk } from '../utils/invokeOk';
import { sectionIdForPlacementIndex } from './sectionMath';
import { getTaskDepth } from './blockMove';
import {
  fileNameSafe,
  getActiveContentFolder,
  nextUniqueMdPath as nextUniqueMdPathLib,
} from '../vault/conventionPaths';
import type { QuickAddParsed } from '../tasks/quickAddParser';
import type { TaskRow } from '../tasks/taskListModel';

/**
 * Task-creation slice for TaskListBoard. Owns the side-effecting flow that
 * combines a new `TileDefinition`, a default-or-quick-add `.md` seed on
 * disk, document-store hydration, and the `AddTaskCommand` dispatch.
 * Factory closes over reactive accessors so the extracted helpers always
 * see the live board / sections / rows state without capturing stale
 * snapshots. Mirrors `kanbanTileCreation.ts` from Phase 5.7.
 */

/** Wrapper around the lib helper so callers don't pass the board cache. */
export function nextUniqueMdPath(folder: string, baseName: string): string {
  return nextUniqueMdPathLib(boardCacheStore.cache, folder, baseName);
}

function buildBaseTileStyle() {
  const fs = defaultTaskFontSizes();
  return {
    ...defaultTileStyleSnapshot(),
    ...(fs.fontSizeTitle !== undefined && { fontSizeTitle: fs.fontSizeTitle }),
  };
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
  contentId: string;
  relPath: string;
  finalTitle: string;
  fm: Record<string, unknown> | null;
  def: TileDefinition;
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
        const d = def as Record<string, unknown>;
        if (d.type === 'text' && typeof d.title === 'string') taken.add(d.title);
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

  // Shared seed routine: writes the `.md`, hydrates the documentStore, and
  // (for non-null `fm`) caches the frontmatter so the row builder doesn't
  // lag the watcher. Returns silently with a toast on failure.
  async function seedMdFile(args: SeedFileArgs, kindForError: string): Promise<void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    const { contentId, relPath, finalTitle, fm, def } = args;
    try {
      const seedBody = fm ? assembleMarkdownFile(fm, '') : '---\ncompleted: false\n---\n';
      await trackComponentWrite(vaultRoot, relPath, async () => {
        // allow-direct-write: seeds a NEW task .md file; mkdir -p required
        // and `markHydrated(relPath, false)` below makes subsequent gateway
        // writes route normally.
        await invokeOk('vault:write-file-text', vaultRoot, relPath, seedBody);
      });
      // Orphan-fm semantics: file just created on disk. Mark hydrated so the
      // gateway accepts subsequent writes (from TextTile, PropertiesPopup,
      // etc.) without throwing — the file existed before the next edit.
      markHydrated(relPath, false);
      (def as Record<string, unknown>).filePath = relPath;
      documentStore.loadDocument({
        docId: contentId,
        filename: relPath,
        title: finalTitle,
        body: seedBody,
        htmlContent: '',
        richText: [],
      });
      if (fm) documentStore.setFrontmatter(contentId, fm);
      // Pre-warm the vault index so the row builder (which sources fields
      // via vaultIndexStore) doesn't lag behind the watcher debounce.
      await vaultIndexStore.applyChanges([relPath]);
    } catch (err) {
      reportError(
        'tasklist.seed-md',
        err,
        `Failed to create backing file for "${finalTitle}" (${kindForError}) — the task may not persist correctly`,
      );
    }
  }

  function buildTaskDef(args: {
    title: string;
    folder: string;
    extraFm: Record<string, unknown> | null;
    tags?: string[];
  }): { def: TileDefinition; contentId: string; relPath: string; finalTitle: string } {
    const now = Date.now();
    const tileId = createId();
    const contentId = createId();
    const baseSafe = fileNameSafe(args.title);
    const relPath = nextUniqueMdPath(args.folder, baseSafe);
    const finalTitle = relPath
      .slice(args.folder ? args.folder.length + 1 : 0)
      .replace(/\.md$/, '');
    const def: TileDefinition = {
      id: tileId,
      type: 'text',
      title: finalTitle,
      style: buildBaseTileStyle(),
      tags: args.tags ?? [],
      createdAt: now,
      updatedAt: now,
    } as TileDefinition;
    (def as Record<string, unknown>).contentId = contentId;
    (def as Record<string, unknown>).content = '';
    return { def, contentId, relPath, finalTitle };
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
    const { def, contentId, relPath, finalTitle } = buildTaskDef({
      title: nextDefaultTitle(),
      folder,
      extraFm: null,
    });
    await seedMdFile({ contentId, relPath, finalTitle, fm: null, def }, 'new task');
    const insertPos = endOfSectionIndex(targetSectionId);
    historyStore.execute(
      new AddTaskCommand(board.id, def, insertPos, undefined, targetSectionId ?? undefined),
    );
    tickAndPersist();
    announce(`Task added: ${finalTitle}`);
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
    // bottom (Phase 6 audit: previous "last section" fallback was the
    // primary source of "task created in wrong section" reports).
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
    const { def, contentId, relPath, finalTitle } = buildTaskDef({
      title,
      folder,
      extraFm: null,
      tags: parsed.tags.length > 0 ? [...parsed.tags] : [],
    });

    const fm: Record<string, unknown> = { completed: false };
    if (parsed.priority) fm.priority = parsed.priority;
    if (parsed.dueDate) fm.dueDate = parsed.dueDate;
    if (parsed.dueTime) fm.dueTime = parsed.dueTime;
    if (parsed.startDate) fm.startDate = parsed.startDate;
    if (parsed.status) fm.status = parsed.status;
    if (parsed.tags.length > 0) fm.tags = [...parsed.tags];

    // Materialise the default section *before* the await so we carry a real
    // section id across the seed; the index itself is recomputed afterwards
    // (same TOCTOU fix as createTaskInSection).
    let resolvedTargetId: string | null = null;
    if (targetSectionId) {
      resolvedTargetId = targetSectionId === defaultSectionId
        ? ensureDefaultSectionMaterialized()
        : targetSectionId;
    }

    await seedMdFile({ contentId, relPath, finalTitle, fm, def }, 'quick-add task');

    const placementsAfter = getPlacements();
    let insertPos = placementsAfter.length;
    if (resolvedTargetId) {
      const sectionsAfter = getSections();
      const sortedLive = [...sectionsAfter].sort((a, b) => a.position - b.position);
      const idx = sortedLive.findIndex((s) => s.id === resolvedTargetId);
      if (idx >= 0) {
        insertPos = sortedLive[idx + 1]?.position ?? placementsAfter.length;
      }
    }

    historyStore.execute(
      new AddTaskCommand(board.id, def, insertPos, undefined, resolvedTargetId ?? undefined),
    );
    tickAndPersist();
    if (resolvedTargetId) setLastTargetedSectionId(resolvedTargetId);
    announce(`Task added from quick add: ${finalTitle}`);
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
    const { def, contentId, relPath, finalTitle } = buildTaskDef({
      title: nextSubtaskTitle(parentTileId),
      folder,
      extraFm: null,
    });

    const fm: Record<string, unknown> = { completed: false, parent: parentTileId };
    await seedMdFile({ contentId, relPath, finalTitle, fm, def }, 'subtask');

    // Recompute the parent index against the *current* placements — they
    // may have shifted while we were awaiting the seed (sibling subtask
    // creations, watcher reload, drag-drop). Falling back to end-of-list
    // also covers the rare case where the parent was deleted mid-flight.
    const placementsAfter = getPlacements();
    const sectionsAfter = getSections();
    const parentIdx = placementsAfter.findIndex((p) => p.tileId === parentTileId);
    const insertAt = parentIdx >= 0 ? parentIdx + 1 : placementsAfter.length;
    const parentSection = parentIdx >= 0 ? sectionIdForPlacementIndex(sectionsAfter, parentIdx) : null;
    historyStore.execute(
      new AddTaskCommand(board.id, def, insertAt, undefined, parentSection ?? undefined),
    );

    if (collapsedSubtasks.has(parentTileId)) {
      const next = new Set(collapsedSubtasks);
      next.delete(parentTileId);
      persistCollapsedSubtasks(next);
    }

    if (parentSection) setLastTargetedSectionId(parentSection);

    tickAndPersist();
    announce(`Subtask added: ${finalTitle}`);
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
