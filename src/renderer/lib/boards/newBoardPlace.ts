/**
 * Where a new board would go in the open vault, and whether its name is free
 * there. The name fields check this as the user types; `board:create` is
 * still the authority (an exclusive create), so a name taken meanwhile is
 * refused there too.
 */
import { vaultStore } from '../../stores/vault.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { directoryExistsInTree, flattenTreePaths } from '../vault/vaultTreeSort';
import { normalizeVaultRelative } from '../utils/path';
import {
  boardNameFromPath,
  boardNameProblem,
  freeBoardName,
  parentFolder,
  plannedBoardPlace,
  type BoardPlace,
} from './boardNaming';

/** The open vault's place for a new board named `name`. */
export function newBoardPlace(name: string): BoardPlace {
  return plannedBoardPlace(name, {
    boardFolders: vaultStore.project?.settings?.general?.boardFolders === true,
    rootFolder: vaultStore.activeRootFolder,
  });
}

/**
 * True when `relPath` is a file Filo knows of: in the vault tree, or a board
 * whose file the tree hasn't listed yet (the tree refresh after a create
 * lands a moment later). Case-folded, as the file system compares names.
 */
export function isVaultFileKnown(relPath: string): boolean {
  const target = normalizeVaultRelative(relPath);
  for (const p of Object.values(boardCacheStore.paths)) {
    if (normalizeVaultRelative(p) === target) return true;
  }
  const root = vaultStore.path;
  if (!root) return false;
  for (const p of flattenTreePaths(vaultStore.rawTree ?? [], root)) {
    if (normalizeVaultRelative(p) === target) return true;
  }
  return false;
}

/**
 * True when a new board's own folder would be one that already exists. A
 * board delete leaves its folder (and the notes in it) behind, so a new board
 * of the same name would otherwise move in and pin the old board's files.
 */
function folderAlreadyThere(place: BoardPlace): boolean {
  const root = vaultStore.path;
  if (!place.folder || !root) return false;
  return directoryExistsInTree(vaultStore.rawTree ?? [], `${root.replace(/[\\/]+$/, '')}/${place.folder}`);
}

/** The file of another board anywhere in the vault named `name` (any letter case), or null. */
function otherBoardNamed(name: string, exceptBoardId?: string): string | null {
  const key = normalizeVaultRelative(name.trim());
  for (const [boardId, path] of Object.entries(boardCacheStore.paths)) {
    if (boardId !== exceptBoardId && normalizeVaultRelative(boardNameFromPath(path)) === key) return path;
  }
  return null;
}

/**
 * With board-specific folders on, a board's name must be free in the whole
 * vault, not only in its folder: each board is alone in a folder of its own,
 * so a same-folder check would never stop two boards sharing a name (two tabs
 * that can't be told apart). Why `name` is taken, or null.
 */
export function boardNameTakenWithFolders(name: string, exceptBoardId?: string): string | null {
  if (vaultStore.project?.settings?.general?.boardFolders !== true) return null;
  const other = otherBoardNamed(name, exceptBoardId);
  if (!other) return null;
  const folder = parentFolder(other);
  return `A board named "${name.trim()}" already exists${folder ? ` in "${folder}"` : ''}.`;
}

/** Why a new board can't be named `name`, or `null` when it can. */
export function newBoardNameProblem(name: string): string | null {
  const problem = boardNameProblem(name);
  if (problem) return problem;
  const place = newBoardPlace(name);
  const where = place.folder ? ` in "${place.folder}"` : '';
  if (isVaultFileKnown(place.path)) return `A board named "${name.trim()}" already exists${where}.`;
  if (folderAlreadyThere(place)) return `A folder named "${place.folder}" already exists. Pick another name for the board.`;
  return boardNameTakenWithFolders(name);
}

/**
 * True when Filo shouldn't pick `name` for a new board itself: its file or
 * its own folder is taken, or another board anywhere in the vault already
 * has that name (two tabs with one name can't be told apart).
 */
export function isNewBoardNameTaken(name: string): boolean {
  const place = newBoardPlace(name);
  if (isVaultFileKnown(place.path) || folderAlreadyThere(place)) return true;
  return otherBoardNamed(name) !== null;
}

/** `base`, or `base 2`, `base 3`, … whichever is free first. */
export function freeNewBoardName(base: string): string {
  return freeBoardName(base, isNewBoardNameTaken);
}
