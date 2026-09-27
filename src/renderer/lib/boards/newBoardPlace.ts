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
import { boardNameFromPath, boardNameProblem, freeBoardName, plannedBoardPlace, type BoardPlace } from './boardNaming';

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

/** Why a new board can't be named `name`, or `null` when it can. */
export function newBoardNameProblem(name: string): string | null {
  const problem = boardNameProblem(name);
  if (problem) return problem;
  const place = newBoardPlace(name);
  const where = place.folder ? ` in "${place.folder}"` : '';
  if (isVaultFileKnown(place.path)) return `A board named "${name.trim()}" already exists${where}.`;
  if (folderAlreadyThere(place)) return `A folder named "${place.folder}" already exists. Pick another name for the board.`;
  return null;
}

/**
 * True when Filo shouldn't pick `name` for a new board itself: its file or
 * its own folder is taken, or another board anywhere in the vault already
 * has that name (two tabs with one name can't be told apart).
 */
export function isNewBoardNameTaken(name: string): boolean {
  const place = newBoardPlace(name);
  if (isVaultFileKnown(place.path) || folderAlreadyThere(place)) return true;
  const key = normalizeVaultRelative(name.trim());
  return Object.values(boardCacheStore.paths).some((p) => normalizeVaultRelative(boardNameFromPath(p)) === key);
}

/** `base`, or `base 2`, `base 3`, … whichever is free first. */
export function freeNewBoardName(base: string): string {
  return freeBoardName(base, isNewBoardNameTaken);
}
