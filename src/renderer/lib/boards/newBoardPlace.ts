/**
 * Where a new board would go in the open vault, and whether its name is free
 * there. The name fields check this as the user types; `board:create` is
 * still the authority (an exclusive create), so a name taken meanwhile is
 * refused there too.
 */
import { vaultStore } from '../../stores/vault.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { flattenTreePaths } from '../vault/vaultTreeSort';
import { normalizeVaultRelative } from '../utils/path';
import { boardNameProblem, freeBoardName, plannedBoardPlace, type BoardPlace } from './boardNaming';

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

/** Why a new board can't be named `name`, or `null` when it can. */
export function newBoardNameProblem(name: string): string | null {
  const problem = boardNameProblem(name);
  if (problem) return problem;
  const place = newBoardPlace(name);
  if (!isVaultFileKnown(place.path)) return null;
  const where = place.folder ? ` in "${place.folder}"` : '';
  return `A board named "${name.trim()}" already exists${where}.`;
}

/** `base`, or `base 2`, `base 3`, … whichever is free first. */
export function freeNewBoardName(base: string): string {
  return freeBoardName(base, (name) => isVaultFileKnown(newBoardPlace(name).path));
}
