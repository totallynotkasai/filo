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
import { fileTagsStore } from '../../stores/fileTags.svelte';
import { AddTaskCommand } from '../../commands/index';
import { createUniqueMdFile } from '../vault/createMdExclusive';
import { reportError } from '../utils/errorBus';
import { buildTextTileDefFromMarkdownFile } from '../canvas/markdownTileSeed';
import { vaultRelativeFromAbsolute } from '../canvas/vaultPath';
import { createId } from '../utils/ids';
import { isMarkdownExtension } from '../vault/extension';
import {
  fileNameSafe,
  getActiveContentFolder,
  nextFreeMdPath as nextFreeMdPathLib,
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
 *      / `.markdown` is copied into the active content folder and added
 *      as a task placement; multi-file OS drags get a hint toast.
 *
 * Factory closes over accessors so the handler always sees the live board /
 * sections / placements state from the caller.
 */

function nextUniqueMdPath(folder: string, baseName: string): string {
  return nextFreeMdPathLib(boardCacheStore.cache, folder, baseName);
}

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
   * Import a Markdown file dragged from the OS file manager into a Task
   * List section. The file's contents are written into the active content
   * folder CREATE-EXCLUSIVELY (an existing vault file with the
   * same name is never overwritten; the import bumps to ` (n)`), then added as a
   * task placement just like the vault-sidebar drop path.
   */
  async function importOsMarkdownFile(
    file: File,
    sectionId: string | null,
    clientY: number | null,
  ): Promise<void> {
    const board = getBoard();
    if (!board) return;
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;

    const rawContent = await file.text();
    const baseName = file.name.replace(/\.(md|markdown)$/i, '');
    const folder = getActiveContentFolder(board);
    const safeBase = fileNameSafe(baseName);
    let relPath = nextUniqueMdPath(folder, safeBase);

    try {
      const created = await createUniqueMdFile({
        vaultRoot,
        folder,
        baseName: safeBase,
        firstCandidate: relPath,
        buildContent: () => rawContent,
      });
      relPath = created.relPath;
    } catch (err) {
      reportError(
        'tasklist.import-md',
        err,
        `Failed to import "${file.name}" into the task list`,
      );
      return;
    }

    const realTargetId = resolveTargetId(sectionId);
    const tilesById = getTilesById();
    const existing = Object.values(tilesById) as Array<{
      type: string; title?: string; contentId?: string; filePath?: string;
    }>;
    const { def, tagFileKey } = buildTextTileDefFromMarkdownFile({
      rawContent,
      vaultRelPath: relPath,
      boardType: board.type,
      boardName: board.name,
      existingTiles: existing,
      conventionFolderOverride: folder,
    });

    // Pin the explicit `filePath` onto the def before
    // AddTaskCommand deep-clones it. buildTextTileDefFromMarkdownFile only stamps
    // filePath when the drop sits OUTSIDE the board's convention folder; an
    // at-convention drop is left to the cascade fallback, which a later
    // default-folder/vault-root change can diverge. `relPath` is the file we just
    // wrote, so stamp it unconditionally (a no-op when the helper already set it).
    (def as Record<string, unknown>).filePath = relPath;
    // The OS import COPIES the file to a brand-new vault path. If the
    // source `.md` carried a frontmatter `id:`, `buildTextTileDefFromMarkdownFile`
    // reused it as the contentId (docId); importing the same source twice — or one
    // whose `id:` collides with an in-vault file — would then back TWO distinct
    // files with ONE docId, sharing a frontmatter cache so a field edit on one row
    // silently rewrites the other. A freshly created file gets a fresh identity:
    // mint a new contentId so one file == one docId.
    (def as Record<string, unknown>).contentId = createId();
    // Thread the resolved target section into the command so
    // persistAddTaskPlacement pins it (parity with createTaskInSection). Without
    // it the placement lands by raw numeric position only, misrouting a drop onto
    // an empty / adjacent-tie section into the wrong one.
    const insertPos = computeInsertPos(realTargetId, clientY);
    historyStore.execute(
      new AddTaskCommand(board.id, def, insertPos, undefined, realTargetId ?? undefined),
    );
    if (def.tags && def.tags.length > 0) {
      fileTagsStore.setFileTags(tagFileKey, def.tags);
    }
    await vaultStore.refreshTree();
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
      await importOsMarkdownFile(mdFile, sectionId, e.clientY);
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

    const realTargetId = resolveTargetId(sectionId);

    // The vault-sidebar payload's `path` is already absolute (see
    // VaultFileItem.svelte). The IPC takes
    // (vaultRoot, relativePath) only; compute the relative form first
    // and let the handler do the join.
    const relPath = vaultRelativeFromAbsolute(parsed.path, vaultRoot) || parsed.path;
    let rawContent = '';
    try {
      const readResult = await window.filo.invoke('vault:read-file-text', vaultRoot, relPath);
      if (readResult.success) rawContent = readResult.content;
    } catch {
      // Best-effort read — empty content falls through to default seed.
    }

    const tilesById = getTilesById();
    const existing = Object.values(tilesById) as Array<{
      type: string; title?: string; contentId?: string; filePath?: string;
    }>;
    const { def, tagFileKey } = buildTextTileDefFromMarkdownFile({
      rawContent,
      vaultRelPath: relPath,
      boardType: board.type,
      boardName: board.name,
      existingTiles: existing,
      conventionFolderOverride: getActiveContentFolder(board),
    });

    // See importOsMarkdownFile: pin the explicit filePath
    // onto the def pre-clone so a cold field/tag edit on this subfolder task
    // resolves to the real file even if the folder cascade later diverges.
    (def as Record<string, unknown>).filePath = relPath;
    // Thread the resolved target section (see importOsMarkdownFile).
    // The vault-sidebar drop references the file in place (same path), so unlike
    // the OS import it keeps any reused contentId — that is the legitimate
    // "same file referenced again" case, deduped at bulk-edit time.
    const insertPos = computeInsertPos(realTargetId, e.clientY);

    historyStore.execute(
      new AddTaskCommand(board.id, def, insertPos, undefined, realTargetId ?? undefined),
    );
    if (def.tags && def.tags.length > 0) {
      fileTagsStore.setFileTags(tagFileKey, def.tags);
    }
    await vaultStore.refreshTree();
    // refreshTree() walks the directory; it does not re-read frontmatter.
    // applyChanges does — without it the sidebar's tag chips lag.
    await vaultIndexStore.applyChanges([relPath]);
    tickAndPersist();
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
