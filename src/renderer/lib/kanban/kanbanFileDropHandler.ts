import type { Board, Tile, TileDefinition } from '../../schema/index';
import { defaultTileStyleSnapshot } from '../../constants/defaults';
import { createId } from '../utils/ids';
import { buildTextTileDefFromMarkdownFile } from '../canvas/markdownTileSeed';
import { isMarkdownExtension, normalizeExtension } from '../vault/extension';
import { vaultRelativeFromAbsolute } from '../canvas/vaultPath';
import { toPosix } from '../utils/path';
import { getActiveContentFolder } from '../vault/conventionPaths';
import { fileTagsStore } from '../../stores/fileTags.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { copyFileIntoVault } from '../vault/vaultOperations';

/**
 * Kanban file-drop helpers — extract the pure-data side of OS / vault-sidebar
 * drops onto a Kanban column. Mime-and-extension inference, vault-file def
 * construction, OS file copy + tile def construction, and `.md` def parsing.
 *
 * Callers retain control over `historyStore.execute` + `tickAndPersist` so
 * batched commands (e.g. multi-file drops) stay grouped under one undo entry.
 */

export type KanbanFileTileType = 'text' | 'image' | 'audio' | 'file';

/**
 * Infers the Kanban-compatible tile type from a file's MIME and extension.
 * Returns `null` for unsupported types (video/iframe/timer are rejected per
 * V7 Kanban rules).
 *
 * Callers supply either dotted (vault sidebar's `extname()` output, e.g.
 * `.md`) or dotless (OS-file split-on-dot) forms — `normalizeExtension`
 * collapses both before the lookup.
 */
export function inferKanbanTileType(
  mime: string,
  ext: string,
): KanbanFileTileType | null {
  const e = normalizeExtension(ext);
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(e)) return 'image';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'].includes(e)) return 'audio';
  if (mime === 'text/markdown' || isMarkdownExtension(e)) return 'text';
  // Reject Video / Iframe / Timer per V7 Kanban rules.
  if (mime.startsWith('video/') || ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv'].includes(e)) return null;
  return 'file';
}

function baseTileStyle() {
  return defaultTileStyleSnapshot();
}

/**
 * Builds a text-tile definition from a `.md` file already in the vault.
 * Mirrors the Mind Map's `createTextTileFromFile` path via the shared
 * `buildTextTileDefFromMarkdownFile` helper: reads the file, extracts the
 * frontmatter `docId` so re-drops share editor state, stamps an explicit
 * `filePath` when the source isn't at the board's convention path, and
 * registers any frontmatter tags in `.filo/tags.json`. Returns `null` if
 * the file cannot be read.
 */
export async function buildTextTileDefForKanbanDrop(args: {
  vaultRelPath: string;
  tileId: string;
  now: number;
  vaultRoot: string;
  board: Board | null;
  allTilesById: Record<string, Tile>;
}): Promise<TileDefinition | null> {
  const { vaultRelPath, tileId, now, vaultRoot, board, allTilesById } = args;
  if (!vaultRoot) return null;
  // Phase 37 / 37.6 — canonical two-arg form.
  let rawContent = '';
  try {
    const readResult = await window.filo.invoke('vault:read-file-text', vaultRoot, vaultRelPath);
    if (readResult.success) rawContent = readResult.content;
  } catch {
    // Read failed — proceed with empty content. The buildTextTileDef
    // helper handles the seed case for fresh tile creation.
  }

  const { def, tagFileKey } = buildTextTileDefFromMarkdownFile({
    rawContent,
    vaultRelPath,
    boardType: board?.type ?? null,
    boardName: board?.name,
    kanbanFolder: (board as { kanbanFolder?: string } | null)?.kanbanFolder,
    existingTiles: Object.values(allTilesById) as Array<{
      type: string; title?: string; contentId?: string; filePath?: string;
    }>,
    conventionFolderOverride: getActiveContentFolder(board),
    tileId,
    now,
  });

  if (def.tags.length > 0) {
    fileTagsStore.setFileTags(tagFileKey, def.tags);
  }
  // Re-index the dropped file's frontmatter so the sidebar's tag chips
  // catch up to the cache write without waiting for a watcher event.
  await vaultIndexStore.applyChanges([vaultRelPath]);

  return def;
}

export async function buildTileDefForVaultFile(args: {
  filePath: string;
  name: string;
  extension: string;
  vaultRoot: string;
  board: Board | null;
  allTilesById: Record<string, Tile>;
}): Promise<TileDefinition | null> {
  const { filePath, name, extension, vaultRoot, board, allTilesById } = args;
  const tileId = createId();
  const now = Date.now();
  const tileType = inferKanbanTileType('', extension) ?? 'file';

  const relPath = vaultRelativeFromAbsolute(filePath, vaultRoot) || toPosix(filePath);

  if (tileType === 'text') {
    return await buildTextTileDefForKanbanDrop({
      vaultRelPath: relPath,
      tileId,
      now,
      vaultRoot,
      board,
      allTilesById,
    });
  }

  // Switched from a conditional-spread object literal to a discriminated
  // switch when `TileDefinition` became a `z.discriminatedUnion` (R5). The
  // spread form widened `tileType` and TypeScript couldn't narrow each
  // variant's required fields (image needs `src`, file needs `filePath` +
  // `fileName` + `fileExtension`). The switch lets each branch satisfy its
  // own variant directly.
  const titleFromName = name.replace(/\.[^.]+$/, '');
  const baseDef = {
    id: tileId,
    title: titleFromName,
    style: baseTileStyle(),
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  switch (tileType) {
    case 'image':
      return { ...baseDef, type: 'image' as const, src: relPath };
    case 'audio':
      return {
        ...baseDef,
        type: 'audio' as const,
        src: relPath,
        isPlaying: false,
        isRecording: false,
      };
    case 'file':
      return {
        ...baseDef,
        type: 'file' as const,
        filePath: relPath,
        fileName: name,
        fileExtension: extension,
      };
  }
}

export async function importKanbanFileTile(args: {
  type: KanbanFileTileType;
  tileId: string;
  sourcePath: string;
  fileName: string;
  fileExt: string;
  vaultRoot: string;
  board: Board | null;
  allTilesById: Record<string, Tile>;
  refreshTree: () => Promise<void>;
}): Promise<TileDefinition | null> {
  const { type, tileId, sourcePath, fileName, fileExt, vaultRoot, board, allTilesById, refreshTree } = args;
  const now = Date.now();

  if (type === 'text') {
    // Copy .md to vault root, then build a text tile def referencing it.
    //
    // Phase R2 — drain pending writers before the copy so a debounced
    // `.board.json` write doesn't race the new file's creation.
    const res = await copyFileIntoVault(sourcePath, vaultRoot);
    if (!res.success) return null;
    // The copy result returns either a vault-relative path (preferred) or
    // an absolute path. Normalise to vault-relative so the helper's
    // duplicate detection and convention-path comparison stay correct.
    const resolvedRel = (res.relativePath as string)
      || (res.path ? vaultRelativeFromAbsolute(res.path as string, vaultRoot) : '')
      || fileName;
    // Refresh the file tree so the newly copied file is in the
    // `knownVaultPaths` snapshot before broken-ref detection runs on
    // the new tile.
    await refreshTree();
    return await buildTextTileDefForKanbanDrop({
      vaultRelPath: resolvedRel,
      tileId,
      now,
      vaultRoot,
      board,
      allTilesById,
    });
  }

  // Phase R2 — same drain-before-IPC contract for media tile drops.
  const res = await copyFileIntoVault(sourcePath, vaultRoot);
  if (!res.success) return null;
  const stored: string = res.relativePath || res.path || '';
  const baseTitle = fileName.replace(/\.[^.]+$/, '');
  const baseDef = {
    id: tileId,
    title: baseTitle,
    style: baseTileStyle(),
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
  // Same discriminated-switch shape as `buildTileDefForVaultFile` above —
  // R5's discriminated `TileDefinition` requires per-variant required
  // fields, which a conditional-spread literal couldn't satisfy.
  switch (type) {
    case 'image':
      return { ...baseDef, type: 'image' as const, src: stored };
    case 'audio':
      return {
        ...baseDef,
        type: 'audio' as const,
        src: stored,
        isPlaying: false,
        isRecording: false,
      };
    case 'file':
      return {
        ...baseDef,
        type: 'file' as const,
        filePath: stored,
        fileName,
        fileExtension: fileExt,
      };
  }
}
