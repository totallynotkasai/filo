import type { Tile, TileDefinition } from '../../schema/index';
import { defaultTileStyleSnapshot } from '../../constants/defaults';
import { createId } from '../utils/ids';
import { buildTextTileDefForNote } from '../canvas/markdownTileSeed';
import { isMarkdownExtension, normalizeExtension } from '../vault/extension';
import type { OutsideDrop } from '../vault/droppedFiles';
import { toPosix, toVaultRelative } from '../utils/path';
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
 * Kanban rules).
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
  // Reject Video / Iframe / Timer per the Kanban rules.
  if (mime.startsWith('video/') || ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv'].includes(e)) return null;
  return 'file';
}

function baseTileStyle() {
  return defaultTileStyleSnapshot();
}

/**
 * Builds a text-tile definition for a `.md` file already in the vault: the
 * def names the note by path (see `buildTextTileDefForNote`).
 */
async function buildTextTileDefForKanbanDrop(args: {
  vaultRelPath: string;
  tileId: string;
  now: number;
  allTilesById: Record<string, Tile>;
}): Promise<TileDefinition> {
  const { def } = buildTextTileDefForNote({
    vaultRelPath: args.vaultRelPath,
    existingTiles: Object.values(args.allTilesById),
    tileId: args.tileId,
    now: args.now,
  });
  // Index the dropped note so its title and tags show without waiting for a
  // watcher event.
  await vaultIndexStore.applyChanges([args.vaultRelPath]);
  return def;
}

/** A media or generic-file def: the board stores a caption title and the path. */
function mediaTileDef(
  type: 'image' | 'audio' | 'file',
  id: string,
  title: string,
  path: string,
  now: number,
): TileDefinition {
  const base = { id, title, style: baseTileStyle(), createdAt: now, updatedAt: now };
  switch (type) {
    case 'image':
      return { ...base, type: 'image', src: path };
    case 'audio':
      return { ...base, type: 'audio', src: path, isPlaying: false };
    case 'file':
      return { ...base, type: 'file', filePath: path };
  }
}

/** The display title for a dropped file: its name without the extension. */
function titleFromFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export async function buildTileDefForVaultFile(args: {
  filePath: string;
  name: string;
  extension: string;
  vaultRoot: string;
  allTilesById: Record<string, Tile>;
}): Promise<TileDefinition | null> {
  const { filePath, name, extension, vaultRoot, allTilesById } = args;
  const tileId = createId();
  const now = Date.now();
  const tileType = inferKanbanTileType('', extension) ?? 'file';
  const relPath = toVaultRelative(filePath, vaultRoot) || toPosix(filePath);

  if (tileType === 'text') {
    return await buildTextTileDefForKanbanDrop({ vaultRelPath: relPath, tileId, now, allTilesById });
  }
  return mediaTileDef(tileType, tileId, titleFromFileName(name), relPath, now);
}

/**
 * Copies a file dropped from outside the vault into the board's folder and
 * builds its card. Only an `OutsideDrop` gets here: a file already in the
 * vault is linked by path (`buildTileDefForVaultFile`), never copied.
 */
export async function importKanbanFileTile(args: {
  type: KanbanFileTileType;
  tileId: string;
  drop: OutsideDrop;
  vaultRoot: string;
  /** The board's folder for new files ('' = vault root). */
  destFolder: string;
  allTilesById: Record<string, Tile>;
  refreshTree: () => Promise<void>;
}): Promise<TileDefinition | null> {
  const { type, tileId, drop, vaultRoot, destFolder, allTilesById, refreshTree } = args;
  const { sourcePath, file: { name: fileName } } = drop;
  const now = Date.now();

  // Drain-before-IPC lives in copyFileIntoVault, so a debounced `.board.json`
  // write can't race the new file's creation.
  const res = await copyFileIntoVault(sourcePath, vaultRoot, destFolder);
  if (!res.success) return null;

  if (type === 'text') {
    // The copy result returns either a vault-relative path (preferred) or an
    // absolute path. Normalise to vault-relative for the def.
    const resolvedRel = (res.relativePath as string)
      || (res.path ? toVaultRelative(res.path as string, vaultRoot) : '')
      || fileName;
    // Refresh the file tree so the newly copied file is in the
    // `knownVaultPaths` snapshot before broken-ref detection runs on the tile.
    await refreshTree();
    return await buildTextTileDefForKanbanDrop({ vaultRelPath: resolvedRel, tileId, now, allTilesById });
  }

  const stored: string = res.relativePath || res.path || '';
  return mediaTileDef(type, tileId, titleFromFileName(fileName), stored, now);
}
