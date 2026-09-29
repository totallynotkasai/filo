import type {
  TaskListBoard as TaskListBoardType,
  TaskListSection,
  TaskPlacement,
  Tile,
} from '../../schema/index';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { AddTaskCommand } from '../../commands/index';
import { noteStore } from '../../stores/notes.svelte';
import { reportError } from '../utils/errorBus';
import { samePath, toVaultRelative } from '../utils/path';
import { buildTextTileDefForNote } from '../canvas/markdownTileSeed';
import { classifyDroppedFile, type OutsideDrop } from '../vault/droppedFiles';
import { isMarkdownExtension } from '../vault/extension';
import {
  fileNameSafe,
  getActiveContentFolder,
  nextFreeMdPath,
} from '../vault/conventionPaths';
import { boardCacheStore } from '../../stores/boardCache.svelte';

/**
 * File-drop handler for TaskListBoard.
 *
 * Three drop sources, one entry point (`onSectionBodyDrop`):
 *   1. Vault-sidebar drag — `application/x-vault-file` MIME with a JSON
 *      `{ path, name, extension }` payload. Only `.md` accepted.
 *   2. Multi-select vault drag — `application/x-vault-files` is rejected
 *      with an explicit toast; the UX is intentionally one-at-a-time so
 *      users don't accidentally bulk-import.
 *   3. OS file drag — browser `Files` only, no vault MIME. The first `.md`
 *      / `.markdown` is added as a task: by its path when it is already in
 *      the vault, else copied into the active content folder first;
 *      multi-file OS drags get a hint toast.
 *
 * Factory closes over accessors so the handler always sees the live board /
 * sections / placements state from the caller.
 */

export interface FileDropDeps {
  getBoard: () => TaskListBoardType | null;
  getSections: () => TaskListSection[];
  getPlacements: () => TaskPlacement[];
  getTilesById: () => Record<string, Tile>;
  ensureDefaultSectionMaterialized: () => string | null;
  tickAndPersist: () => void;
  defaultSectionId: string;
}

export interface FileDropHandler {
  onSectionBodyDrop(e: DragEvent, sectionId: string | null): Promise<void>;
}

export function makeFileDropHandler(deps: FileDropDeps): FileDropHandler {
  const {
    getBoard,
    getSections,
    getPlacements,
    getTilesById,
    ensureDefaultSectionMaterialized,
    tickAndPersist,
    defaultSectionId,
  } = deps;

  /**
   * Resolve the synthetic default section to a real persisted id, or pass
   * through the supplied id (including `null` for the leading bucket).
   */
  function resolveTargetId(sectionId: string | null): string | null {
    if (sectionId === defaultSectionId) {
      return ensureDefaultSectionMaterialized();
    }
    return sectionId;
  }

  /**
   * Compute the absolute insertion position in the flat placements array.
   *
   * When `clientY` is provided, walk the section's rendered `[data-task-id]`
   * rows and find the first whose vertical midpoint is below the pointer —
   * insertion lands between cards under the cursor. Falls back to "end of
   * target section" when the section has no rows under the pointer or the
   * DOM lookup fails.
   *
   * `null` realTargetId routes into the leading "Unsectioned" bucket.
   */
  function computeInsertPos(
    realTargetId: string | null,
    clientY: number | null,
  ): number {
    const sections = getSections();
    const placements = getPlacements();
    const sortedLive = [...sections].sort((a, b) => a.position - b.position);

    // End-of-section fallback used by both the no-clientY case and the
    // "pointer is below every row" case.
    const endOfSectionPos = (): number => {
      if (realTargetId !== null) {
        const idx = sortedLive.findIndex((s) => s.id === realTargetId);
        if (idx >= 0) return sortedLive[idx + 1]?.position ?? placements.length;
        return placements.length;
      }
      return sortedLive[0]?.position ?? placements.length;
    };

    if (clientY == null) return endOfSectionPos();

    const sectionSel = realTargetId === null ? '[data-section-id=""]' : `[data-section-id="${realTargetId}"]`;
    const sectionEl = document.querySelector(sectionSel);
    if (!sectionEl) return endOfSectionPos();

    const rows = Array.from(sectionEl.querySelectorAll<HTMLElement>('[data-task-id]'));
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        const tileId = row.getAttribute('data-task-id');
        if (!tileId) continue;
        const placement = placements.find((p) => p.tileId === tileId);
        if (placement) return placement.position;
      }
    }
    return endOfSectionPos();
  }

  /**
   * Import a Markdown file dragged from outside the vault into a Task List
   * section. The file's contents are written into the active content folder
   * CREATE-EXCLUSIVELY (an existing vault file with the same name is never
   * overwritten; the import bumps to ` (n)`), then added as a task. A note
   * already in the vault never gets here: it is added by its path.
   */
  async function importOsMarkdownFile(
    drop: OutsideDrop,
    sectionId: string | null,
    clientY: number | null,
  ): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;

    const file = drop.file;
    const rawContent = await file.text();
    const baseName = file.name.replace(/\.(md|markdown)$/i, '');
    const folder = getActiveContentFolder(board);
    const safeBase = fileNameSafe(baseName);
    let relPath = nextFreeMdPath(boardCacheStore.cache, folder, safeBase);

    try {
      const created = await noteStore.createUnique(relPath, () => rawContent);
      relPath = created.relPath;
    } catch (err) {
      reportError(
        'tasklist.import-md',
        err,
        `Failed to import "${file.name}" into the task list`,
      );
      return;
    }

    await addNoteAsTask(relPath, sectionId, clientY);
  }

  /** Adds the vault note at `relPath` as a task in the section under the pointer. */
  async function addNoteAsTask(relPath: string, sectionId: string | null, clientY: number | null): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const existingTiles = Object.values(getTilesById());
    const { def, duplicate } = buildTextTileDefForNote({ vaultRelPath: relPath, existingTiles });
    // A task is on a list once: a second row would be the same note twice.
    if (duplicate) {
      const existing = existingTiles.find((t) => t.type === 'text' && samePath(t.filePath, def.filePath));
      const row = existing ? document.querySelector<HTMLElement>(`.task-item[data-task-id="${existing.id}"]`) : null;
      row?.scrollIntoView({ block: 'nearest' });
      row?.focus();
      uiStore.toast('Already on this list', 'info', 2200);
      return;
    }
    const realTargetId = resolveTargetId(sectionId);
    // Thread the resolved target section into the command so
    // persistAddTaskPlacement pins it (parity with createTaskInSection). Without
    // it the placement lands by raw numeric position only, misrouting a drop onto
    // an empty / adjacent-tie section into the wrong one.
    const insertPos = computeInsertPos(realTargetId, clientY);
    historyStore.execute(
      new AddTaskCommand(board.id, def, insertPos, undefined, realTargetId ?? undefined),
    );
    await vaultStore.refreshTree();
    // refreshTree() walks the directory; it does not re-read frontmatter.
    // applyChanges does — without it the sidebar's tag chips lag.
    await vaultIndexStore.applyChanges([relPath]);
    tickAndPersist();
  }

  /**
   * Vault sidebar / OS file drop dispatcher. Returns `true` once the event
   * has been handled (preventDefault + stopPropagation already called),
   * `false` when no relevant data was attached.
   */
  async function handleVaultFileDrop(
    e: DragEvent,
    sectionId: string | null,
  ): Promise<boolean> {
    const board = getBoard();
    if (!board) return false;
    const vaultFileData = e.dataTransfer?.getData('application/x-vault-file');
    const vaultFilesData = e.dataTransfer?.getData('application/x-vault-files');
    const osFiles = e.dataTransfer?.files;
    const hasOsFiles = !!osFiles && osFiles.length > 0;
    if (!vaultFileData && !vaultFilesData && !hasOsFiles) return false;

    if (vaultFilesData && !vaultFileData) {
      uiStore.toast('Drag one Markdown file at a time into a Task List', 'warning', 2200);
      return true;
    }

    e.preventDefault();
    e.stopPropagation();

    const vaultRoot = vaultStore.path;
    if (!vaultRoot) {
      uiStore.toast('Open a vault first to import files', 'info', 2000);
      return true;
    }

    // OS-file drop path: when no vault MIME is present we fall through here.
    if (!vaultFileData && hasOsFiles) {
      const fileArr = Array.from(osFiles);
      const mdFile = fileArr.find((f) => /\.(md|markdown)$/i.test(f.name));
      if (!mdFile) {
        uiStore.toast('Task List only accepts Markdown files', 'warning', 2200);
        return true;
      }
      if (fileArr.length > 1) {
        uiStore.toast(
          'Importing the first Markdown file; drag others individually',
          'info',
          2400,
        );
      }
      // A note already in the vault is added by its path, as a sidebar drop
      // is; only one from outside is imported (a copy would be a second note).
      const dropped = classifyDroppedFile(mdFile, vaultRoot);
      if (!dropped) uiStore.toast(`Could not read dropped file: ${mdFile.name}`, 'error', 2500);
      else if (dropped.kind === 'in-vault') await addNoteAsTask(dropped.relPath, sectionId, e.clientY);
      else await importOsMarkdownFile(dropped, sectionId, e.clientY);
      return true;
    }

    let parsed: { path: string; name: string; extension: string };
    try {
      parsed = JSON.parse(vaultFileData!);
    } catch {
      return true;
    }
    // `parsed.extension` is normalised in the helper — vault sidebar passes
    // the leading-dot form (e.g. `.md`).
    if (!isMarkdownExtension(parsed.extension)) {
      uiStore.toast('Task List only accepts Markdown files', 'warning', 2200);
      return true;
    }

    // The vault-sidebar payload's `path` is absolute (see VaultFileItem.svelte).
    await addNoteAsTask(toVaultRelative(parsed.path, vaultRoot) || parsed.path, sectionId, e.clientY);
    return true;
  }

  // Section body / header / padding file-drop adaptor. Task drags are owned
  // by the per-section svelte-dnd-action zone (cross-section moves), so this
  // handler only routes vault-sidebar and OS file drags.
  async function onSectionBodyDrop(e: DragEvent, sectionId: string | null): Promise<void> {
    await handleVaultFileDrop(e, sectionId);
  }

  return { onSectionBodyDrop };
}
