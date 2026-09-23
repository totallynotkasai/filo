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
import type { SeededFile } from '../../commands/taskCommands';
import { createId } from '../utils/ids';
import { assembleMarkdownFile } from '../editor/markdownSync';
import { markHydrated } from '../vault/markdownFileWriter';
import { createUniqueMdFile } from '../vault/createMdExclusive';
import { reportError } from '../utils/errorBus';
import { sectionIdForPlacementIndex } from './sectionMath';
import { getTaskDepth } from './blockMove';
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
 * snapshots. Mirrors `kanbanTileCreation.ts` from Phase 5.7.
 */

/** Wrapper around the lib helper so callers don't pass the board cache. */
export function nextUniqueMdPath(folder: string, baseName: string): string {
  return nextFreeMdPathLib(boardCacheStore.cache, folder, baseName);
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
  // lag the watcher. Resolves the path + title it ACTUALLY created (Audit-19
  // BL-1 — the create-exclusive helper bumps to ` (n)` if the pre-pick exists).
  async function seedMdFile(args: SeedFileArgs, kindForError: string): Promise<SeededFile | void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    const { contentId, fm, folder } = args;
    const seedFile = fm ? assembleMarkdownFile(fm, '') : '---\ncompleted: false\n---\n';
    // A9-M3 (Audit-9) — the backing `.md` write is CRITICAL: let a failure
    // PROPAGATE so the chained `AddTaskCommand.execute()` rolls its placement
    // back (no orphan board row referencing a missing file). The helper routes
    // the failure through the save-error pipeline (toast + `.filo/.dirty`
    // sentinel) before rethrowing. Audit-19 BL-1 — create-EXCLUSIVE: an existing
    // off-board file with the same name is never overwritten.
    const created = await createUniqueMdFile({
      vaultRoot,
      folder,
      baseName: args.finalTitle,
      firstCandidate: args.relPath,
      buildContent: () => seedFile,
    });
    const relPath = created.relPath;
    const finalTitle = created.finalTitle;
    // Post-write hydration is best-effort — the file IS on disk now, so the row
    // is valid; a lagging index / doc-load just hydrates lazily on the next edit.
    // A failure here must NOT roll the placement back (hence its own try/catch).
    try {
      // Orphan-fm semantics: file just created on disk. Mark hydrated so the
      // gateway accepts subsequent writes (from TextTile, PropertiesPopup,
      // etc.) without throwing — the file existed before the next edit.
      markHydrated(relPath, false);
      // Audit-12 H1 — the `def.filePath = relPath` stamp moved to buildTaskDef
      // (pre-clone). Stamping it here was a no-op for persistence: AddTaskCommand
      // had already deep-cloned the def before this runs, so it mutated an object
      // the cache never sees. seedMdFile no longer needs `def` at all.
      // Audit-19 MD-3 — `DocumentState.body` is body-only; the seed is a
      // frontmatter-only FILE with an empty body, so the store body is ''.
      documentStore.loadDocument({
        docId: contentId,
        filename: relPath,
        title: finalTitle,
        body: '',
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
        `Backing file for "${finalTitle}" (${kindForError}) was created, but post-write setup lagged — it should recover on the next edit`,
      );
    }
    return { relPath, title: finalTitle };
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
    // Audit-12 H1 — bake `filePath` into the def HERE, before AddTaskCommand's
    // ctor deep-clones it (`this.def = this.snapshot(def)`). seedMdFile used to
    // stamp it (on the ORIGINAL def) only AFTER the clone had already entered the
    // cache, so the persisted `.board.json` row carried NO `filePath`. On a cold
    // load (boards don't preload docs → documentStore empty) a subfolder task's
    // field/tag write then fell through the per-board folder cascade / vault root
    // and hit the wrong file. Kanban + Mind Map already bake filePath in pre-clone;
    // this brings Task List to parity.
    (def as Record<string, unknown>).filePath = relPath;
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
    // A9-M3 (Audit-9) — the `.md` seed is folded INTO AddTaskCommand.execute()
    // (its last argument), which persists the placement synchronously FIRST and
    // then awaits the seed — all on the history chain. vaultStore.save()/quit
    // therefore cover the seed via whenChainSettled(): a quit inside the seed
    // window no longer persists the placement while losing the `.md`
    // (priority/due/tags). The prior off-chain `await seedMdFile(...)` AFTER
    // execute() did exactly that → an orphan row + lost metadata. On a seed-write
    // failure the command rolls its placement back. Placement-first also keeps
    // the insertPos TOCTOU tight (no concurrent creation shifts the slot across
    // the await). The chain reports its own errors; swallow here on this
    // fire-and-forget UI path.
    const insertPos = endOfSectionIndex(targetSectionId);
    // Audit-16 6.2 — gate the success announcement on the chain resolving.
    // Pre-fix the `.catch(() => {})` swallow announced "Task added" even when
    // the seed write failed and execute() rolled the placement back. The
    // failure announcement gives SR users parity with the visual error toast
    // the seed's create-exclusive helper already raised.
    const cmd = new AddTaskCommand(board.id, def, insertPos, undefined, targetSectionId ?? undefined, () =>
      seedMdFile({ contentId, relPath, finalTitle, folder, fm: null }, 'new task'),
    );
    const ok = await historyStore.execute(cmd).then(() => true, () => false);
    tickAndPersist();
    if (ok) announce(`Task added: ${cmd.currentTitle}`);
    else announce(`Adding task failed: ${finalTitle} — see the error notification`);
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

    // A9-M3 (Audit-9) — compute the insert slot here, then fold the `.md` seed
    // INTO AddTaskCommand.execute() so the placement (synchronous) AND the seed
    // (awaited) both run on the history chain that quit drains via
    // whenChainSettled(). The prior off-chain `await seedMdFile(...)` after
    // execute() let a quit-during-seed persist the placement but lose the typed
    // metadata (priority/due/tags) → orphan row. Reading the live placements
    // here (pre-dispatch) keeps the insertPos TOCTOU tight. See createTaskInSection.
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

    // Audit-16 6.2 — success announcement gated on the chain resolving (see addTask).
    const cmd = new AddTaskCommand(board.id, def, insertPos, undefined, resolvedTargetId ?? undefined, () =>
      seedMdFile({ contentId, relPath, finalTitle, folder, fm }, 'quick-add task'),
    );
    const ok = await historyStore.execute(cmd).then(() => true, () => false);
    tickAndPersist();
    if (resolvedTargetId) setLastTargetedSectionId(resolvedTargetId);
    if (ok) announce(`Task added from quick add: ${cmd.currentTitle}`);
    else announce(`Adding task failed: ${finalTitle} — see the error notification`);
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

    // A9-M3 (Audit-9) — compute the parent index here, then fold the `.md` seed
    // INTO AddTaskCommand.execute() so the placement (synchronous) AND the seed
    // (awaited) both ride the history chain that quit drains via
    // whenChainSettled(). The prior off-chain `await seedMdFile(...)` after
    // execute() let a quit-during-seed persist the placement but lose the typed
    // metadata → orphan `.md`. Reading the live placements here pins our slot
    // before any sibling creation/reload can run (insertPos TOCTOU). Falling back
    // to end-of-list still covers a parent deleted mid-flight.
    const placementsNow = getPlacements();
    const sectionsNow = getSections();
    const parentIdx = placementsNow.findIndex((p) => p.tileId === parentTileId);
    const insertAt = parentIdx >= 0 ? parentIdx + 1 : placementsNow.length;
    const parentSection = parentIdx >= 0 ? sectionIdForPlacementIndex(sectionsNow, parentIdx) : null;
    // Audit-16 6.2 — success announcement gated on the chain resolving (see addTask).
    const cmd = new AddTaskCommand(board.id, def, insertAt, undefined, parentSection ?? undefined, () =>
      seedMdFile({ contentId, relPath, finalTitle, folder, fm }, 'subtask'),
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
    else announce(`Adding subtask failed: ${finalTitle} — see the error notification`);
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
