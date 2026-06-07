import { screenToCanvas } from './coordinates';
import { getTileTypeFromMime, getTileTypeFromExtension, createTile } from '../../stores/tiles.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { framesStore } from '../../stores/frames.svelte';
import { fileTagsStore } from '../../stores/fileTags.svelte';
import { reportError } from '../utils/errorBus';
import { isInsideVault, vaultRelativeFromAbsolute } from './vaultPath';
import { buildTextTileDefFromMarkdownFile } from './markdownTileSeed';
import { copyFileIntoVault } from '../vault/vaultOperations';
import type { TextTile, Tile } from '../../schema/index';
import { getActiveContentFolder, getActiveContentFolderAbs } from '../vault/conventionPaths';
import { historyStore } from '../../stores/history.svelte';
import { AddTilesCommand } from '../../commands/index';
// M5 (Audit-12) — pane-scoped, NOT the global board/canvas facades. A `drop`
// carries no preceding pointerdown to activate the target pane, so reading the
// global `boardStore`/`canvasStore` created the tile on the ACTIVE pane's board
// with the active pane's viewport — wrong pane in a split view. The action now
// takes the pane's BoardScope and creates against `scope.board`/`scope.canvas`.
import { setActiveScope, type BoardScope, type BoardScopeBoard } from '../boards/boardScope.svelte';

/**
 * Electron 32+ removed the legacy `path` property from `File`, but the
 * `webUtils.getPathForFile` bridge (exposed at `window.filo.getPathForFile`)
 * still works. Older drops may still expose `path`, so probe both behind
 * a narrowing projection rather than a wholesale `any` escape hatch.
 */
function resolveDroppedFilePath(file: File): string | undefined {
  const legacyPath = (file as File & { path?: unknown }).path;
  if (typeof legacyPath === 'string' && legacyPath.length > 0) return legacyPath;
  try {
    const resolved = window.filo.getPathForFile?.(file);
    if (resolved) return resolved;
  } catch {
    // Bridge unavailable in some contexts (popout sidebar). Caller surfaces
    // a toast when neither probe yields a path.
  }
  return undefined;
}

/**
 * Drag-and-drop action — handles OS file drops onto the canvas.
 * Converts drop position to canvas coordinates and creates tiles.
 * Media files are copied to the vault's attachments folder.
 * Markdown files become text tile wrappers (document is the source of truth).
 *
 * M5 (Audit-12) — takes the pane's `BoardScope` (mirrors
 * `viewportAction`/`edgePanAction`) so the tile lands on THIS pane's board with
 * THIS pane's viewport, not whichever pane the global facade points at. On drop
 * it also pivots the active scope to this pane so the still-global
 * `framesStore` / `historyStore` resolve to the dropped-on pane too.
 *
 * Usage: <div use:dragDropAction={scope}>...</div>
 */
export function dragDropAction(node: HTMLElement, scope: BoardScope) {
  function onDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  function onDragEnter(e: DragEvent) {
    e.preventDefault();
    node.classList.add('drag-over');
  }

  function onDragLeave(e: DragEvent) {
    if (e.relatedTarget && node.contains(e.relatedTarget as Node)) return;
    node.classList.remove('drag-over');
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    node.classList.remove('drag-over');

    // M5 (Audit-12) — a drop has no preceding pointerdown to activate the target
    // pane (PaneView activates on pointerdowncapture), so the GLOBAL facades
    // (framesStore.syncTileMembership, historyStore push) would still resolve to
    // the previously-active pane. Pivot the active scope to THIS pane up front so
    // those globals target the dropped-on board. Tile placement + viewport use
    // the threaded `scope` directly below, so they're pane-correct regardless.
    setActiveScope(scope);
    historyStore.setActiveBoard(scope.board.current?.id ?? null);

    // Multi-select drag from the vault sidebar uses the plural MIME type
    // `application/x-vault-files`. We refuse it here so the user can't
    // accidentally smear a folder reorganisation onto the canvas — a single
    // toast explains why nothing happened.
    if (e.dataTransfer?.types.includes('application/x-vault-files')) {
      uiStore.toast('Drag one file at a time onto the board', 'info', 2500);
      return;
    }

    const rect = node.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const canvasPos = screenToCanvas(screenX, screenY, scope.canvas.transform);

    // Collected tiles for this drop. Pushed as a single AddTilesCommand at
    // the end so a 30-file drop is one Ctrl+Z, not 30. Phase 16 / H3.
    const dropTiles: Tile[] = [];

    // Handle vault file drops (from VaultSidebar)
    const vaultFileData = e.dataTransfer?.getData('application/x-vault-file');
    if (vaultFileData) {
      // Without an active board, `scope.board.addTile` silently no-ops and
      // the drop appears to "snap back". Surface a toast instead.
      if (!scope.board.current?.id) {
        uiStore.toast('Open a board to drop files', 'info', 2000);
        return;
      }
      try {
        const { path: filePath, name, extension } = JSON.parse(vaultFileData);
        const type = getTileTypeFromExtension(extension);

        if (type === 'text') {
          // .md files become text tile wrappers — read content and link to the file
          const created = await createTextTileFromFile(scope.board, filePath, canvasPos);
          if (created) dropTiles.push(created);
        } else {
          // Compute relative path from vault root for portability. Uses the
          // case-insensitive helper so Windows path comparisons survive
          // drive-letter / casing mismatches; the absolute path is only kept
          // as a last-resort fallback (which would be logged & rejected by
          // toMediaUrl rather than leaking into an `<img src>`).
          const vaultDir = vaultStore.path ?? '';
          const relPath = vaultRelativeFromAbsolute(filePath, vaultDir) || filePath;

          const overrides: Record<string, unknown> = {};
          if (type === 'image' || type === 'video' || type === 'audio') {
            overrides.src = relPath;
          } else {
            overrides.filePath = relPath;
            overrides.fileName = name;
            overrides.fileExtension = extension;
          }

          const tile = createTile(type, canvasPos, scope.board.current?.id || '', overrides);
          scope.board.addTile(tile);
          framesStore.syncTileMembership(tile.id);
          dropTiles.push(tile);
        }
      } catch (err) {
        reportError('canvas.vault-drop', err, 'Failed to import vault file onto the canvas');
      }
      if (dropTiles.length > 0) {
        historyStore.pushWithoutExecute(new AddTilesCommand(dropTiles, `Drop ${dropTiles.length} tile(s)`));
      }
      return;
    }

    if (!e.dataTransfer?.files?.length) return;

    const files = Array.from(e.dataTransfer.files);
    const vaultDir = vaultStore.path;
    // Destination for newly-copied files. Cascade: vault-wide pin →
    // active board's per-board pin → vault root. The resolver returns ''
    // when there is no open vault, so vaultDir wins via the OR fallback.
    const targetDir = getActiveContentFolderAbs(scope.board.current) || vaultDir;

    if (!vaultDir) {
      uiStore.toast('Save the project first to enable file drops', 'info', 2000);
      return;
    }

    let offsetX = 0;
    const reportCopyFailure = (name: string, code?: string): void => {
      const reason = code === 'FILE_TOO_LARGE'
        ? 'File too large (100 MB max per drop)'
        : code === 'FORBIDDEN' || code === 'INVALID_FILENAME'
          ? 'File rejected by vault safety check'
          : code === 'ENOSPC'
            ? 'Disk full'
            : code === 'EACCES'
              ? 'Permission denied'
              : 'Failed to import';
      uiStore.toast(`${reason}: ${name}`, 'error', 2500);
    };
    for (const file of files) {
      try {
        const fileExt = file.name.split('.').pop() || '';
        const type = file.type ? getTileTypeFromMime(file.type) : getTileTypeFromExtension(fileExt);

        const sourcePath = resolveDroppedFilePath(file);

        // If the OS-dragged file is already inside the vault, do NOT copy
        // it (which would create a duplicate like "NotesTest (1).md").
        // Instead, link the existing file as a tile — same code path as the
        // sidebar drop branch above.
        if (sourcePath && isInsideVault(sourcePath, vaultDir)) {
          const dropPos = { x: canvasPos.x + offsetX, y: canvasPos.y };
          if (type === 'text') {
            const created = await createTextTileFromFile(scope.board, sourcePath, dropPos);
            if (created) dropTiles.push(created);
          } else {
            const relPath = vaultRelativeFromAbsolute(sourcePath, vaultDir);
            const overrides: Record<string, unknown> = {};
            if (type === 'image' || type === 'video' || type === 'audio') {
              overrides.src = relPath;
            } else {
              overrides.filePath = relPath;
              overrides.fileName = file.name;
              overrides.fileExtension = fileExt;
            }
            const tile = createTile(type, dropPos, scope.board.current?.id || '', overrides);
            scope.board.addTile(tile);
            framesStore.syncTileMembership(tile.id);
            dropTiles.push(tile);
          }
          offsetX += 260;
          continue;
        }

        if (type === 'text' && sourcePath) {
          // .md files: copy to the active root directory (vault root or
          // user-pinned folder), then create text tile wrapper.
          //
          // Phase R2 — routes through `copyFileIntoVault` so pending
          // writers drain before the copy lands; otherwise a 300 ms-armed
          // `.board.json` write could fire after the copy and either
          // clobber the new file's referent or stamp a stale tile def.
          const res = await copyFileIntoVault(sourcePath, targetDir);
          if (res.success) {
            // Refresh the file tree so the newly copied file is in the
            // `knownVaultPaths` snapshot before broken-ref detection runs on
            // the new tile — otherwise the tile gets flagged on first render.
            await vaultStore.refreshTree();
            const dropPos = { x: canvasPos.x + offsetX, y: canvasPos.y };
            const created = await createTextTileFromFile(scope.board, res.path, dropPos);
            if (created) dropTiles.push(created);
            offsetX += 260;
          } else {
            reportCopyFailure(file.name, res.code);
          }
        } else if (sourcePath) {
          // Free-form attachments: canvas drops land at the active root
          // directory (vault root by default, or the user-pinned folder).
          // Filename collisions get a `(1)`, `(2)`, … suffix server-side.
          //
          // Phase R2 — same drain-before-IPC contract as the .md branch.
          const res = await copyFileIntoVault(sourcePath, targetDir);

          if (res.success) {
            const storedPath = res.relativePath || res.path;

            // Refresh the file tree so the newly copied file is in the
            // `knownVaultPaths` snapshot before broken-ref detection runs on
            // the new tile — otherwise the tile gets a "Backing File Missing"
            // badge on first render.
            await vaultStore.refreshTree();

            const overrides: Record<string, unknown> = {};
            if (type === 'image' || type === 'video' || type === 'audio') {
              overrides.src = storedPath;
            } else {
              overrides.filePath = storedPath;
              overrides.fileName = file.name;
              overrides.fileExtension = fileExt;
            }

            const dropPos = { x: canvasPos.x + offsetX, y: canvasPos.y };
            const tile = createTile(type, dropPos, scope.board.current?.id || '', overrides);
            scope.board.addTile(tile);
            framesStore.syncTileMembership(tile.id);
            dropTiles.push(tile);
            offsetX += 260;
          } else {
            reportCopyFailure(file.name, res.code);
          }
        } else {
          // No OS path available even after `webUtils.getPathForFile` — the
          // drop didn't carry a real on-disk file (e.g. from a virtual
          // source) so there's nothing to copy into the vault. Surface a
          // toast rather than silently creating a broken/data-URL tile.
          uiStore.toast(`Could not read dropped file: ${file.name}`, 'error', 2500);
        }
      } catch (err) {
        reportError(
          'canvas.os-drop',
          err,
          `Failed to import "${file.name}" onto the canvas`,
        );
      }
    }
    if (dropTiles.length > 0) {
      historyStore.pushWithoutExecute(new AddTilesCommand(dropTiles, `Drop ${dropTiles.length} tile(s)`));
    }
  }

  node.addEventListener('dragover', onDragOver);
  node.addEventListener('dragenter', onDragEnter);
  node.addEventListener('dragleave', onDragLeave);
  node.addEventListener('drop', onDrop);

  return {
    destroy() {
      node.removeEventListener('dragover', onDragOver);
      node.removeEventListener('dragenter', onDragEnter);
      node.removeEventListener('dragleave', onDragLeave);
      node.removeEventListener('drop', onDrop);
    },
  };
}

/**
 * Creates a text tile from a .md file already in the vault.
 * The tile wraps the .md file — like Obsidian, the file is the source of truth.
 * If the .md has Filo frontmatter with an existing docId, it reuses that ID
 * so the new tile shares editor state with any other tile of the same file.
 *
 * On re-drop of a file that already has a representing tile on this board,
 * a non-blocking "Duplicate tile on Board" toast is emitted. The duplicate
 * is still created (intentional feature — `documentStore` syncs content via
 * `contentId`); the toast simply tells the user another tile already exists.
 *
 * The new tile receives an explicit `filePath` whenever the dropped file is
 * NOT at the board's convention path for the derived title. Without this
 * stamp, the next save would fall back to `${title}.md` at the convention
 * folder (vault root for mindmap) and recreate the file there.
 */
async function createTextTileFromFile(
  boardScope: BoardScopeBoard,
  filePath: string,
  position: { x: number; y: number },
): Promise<Tile | null> {
  const vaultDir = vaultStore.path;
  const board = boardScope.current;
  const boardId = board?.id || '';

  if (!vaultDir) {
    uiStore.toast('No vault open', 'error', 2000);
    return null;
  }

  // Phase 37 / 37.6 — canonical two-arg form. Resolve to vault-relative
  // first; the IPC handler joins it back onto the active vault root.
  const relPath = vaultRelativeFromAbsolute(filePath, vaultDir) || filePath;
  const readResult = await window.filo.invoke('vault:read-file-text', vaultDir, relPath);
  if (!readResult.success) {
    uiStore.toast('Failed to read markdown file', 'error', 2000);
    return null;
  }

  const rawContent = readResult.content;

  const { def, tagFileKey } = buildTextTileDefFromMarkdownFile({
    rawContent,
    vaultRelPath: relPath,
    boardType: board?.type ?? null,
    boardName: (board as { name?: string } | null)?.name,
    kanbanFolder: (board as { kanbanFolder?: string } | null)?.kanbanFolder,
    existingTiles: Object.values(boardScope.tiles) as Array<TextTile>,
    conventionFolderOverride: getActiveContentFolder(board),
  });

  const overrides: Record<string, unknown> = {
    contentId: (def as { contentId?: string }).contentId,
    content: (def as { content?: string }).content,
    title: def.title,
  };
  const explicitFilePath = (def as { filePath?: string }).filePath;
  if (explicitFilePath) {
    overrides.filePath = explicitFilePath;
  }
  if (def.tags.length > 0) {
    overrides.tags = def.tags;
  }

  const tile = createTile('text', position, boardId, overrides);
  boardScope.addTile(tile);
  framesStore.syncTileMembership(tile.id);

  // Register the file's frontmatter tags in `.filo/tags.json` so the Tag
  // Browser and TagBadge colour resolver are consistent with the new tile's
  // badges. The key mirrors `resolveTextTileFilePath` (fileTags.svelte.ts)
  // so subsequent TagEditor edits operate on the same entry.
  if (def.tags.length > 0) {
    fileTagsStore.setFileTags(tagFileKey, def.tags);
  }
  return tile;
}

