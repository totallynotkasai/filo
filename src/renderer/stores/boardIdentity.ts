/**
 * A board's name and emoji, changed from its tab or the Board Browser.
 *
 * The name is the `.board.json` file stem: renaming a board renames its file,
 * and a file renamed in the sidebar or by another program renames the board.
 * The JSON's `board.name`, the project's board list (sidebar, Board Browser,
 * search) and every open tab showing the board hold copies for display, so
 * each change updates all of them at once.
 */
import { boardCacheStore } from './boardCache.svelte';
import { tabStore } from './tabs.svelte';
import { uiStore } from './ui.svelte';
import { vaultStore } from './vault.svelte';
import {
  boardNameFromPath,
  boardNameProblem,
  boardPathIn,
  folderFollowingRename,
  parentFolder,
  renamedFolder,
} from '../lib/boards/boardNaming';
import { boardNameTakenWithFolders, isVaultFileKnown } from '../lib/boards/newBoardPlace';
import { registerPathRenamable, rebasePath } from '../lib/vault/renamePathKeys';
import { directoryExistsInTree } from '../lib/vault/vaultTreeSort';
import { samePath } from '../lib/utils/path';

/** The board's name everywhere a copy of it is shown. */
function applyBoardName(boardId: string, name: string): void {
  const cached = boardCacheStore.cache[boardId]?.board;
  if (cached && cached.name !== name) boardCacheStore.updateBoardIdentity(boardId, { name });
  const listed = vaultStore.project?.boards.find((b) => b.id === boardId);
  if (listed && listed.name !== name) listed.name = name;
  for (const tab of tabStore.tabs) {
    if (tab.boardId === boardId && tab.name !== name) tabStore.rename(tab.id, name);
  }
}

function absPath(rel: string): string {
  return `${(vaultStore.path ?? '').replace(/[\\/]+$/, '')}/${rel}`;
}

/**
 * Why the board can't be renamed to `name`, or `null` when it can. Shown
 * inline while the user types: the name must be a usable file name, and no
 * other board file in the same folder may already have it. With board folders
 * on, no other board anywhere in the vault may have it.
 */
export function boardRenameProblem(boardId: string, name: string): string | null {
  const next = name.trim();
  const problem = boardNameProblem(next);
  if (problem) return problem;
  const path = boardCacheStore.paths[boardId];
  if (!path) return null;
  const folder = parentFolder(path);
  const target = boardPathIn(folder, next);
  // Its own file under another case is not a clash.
  if (samePath(target, path)) return null;
  if (isVaultFileKnown(target)) return `A board named "${next}" already exists${folder ? ` in "${folder}"` : ''}.`;
  return boardNameTakenWithFolders(next, boardId);
}

/**
 * Renames the board and its `.board.json`. With board folders on, the folder
 * holding the file follows too, but only while it is still named after the
 * board; a folder whose new name is taken keeps its name, with a notice.
 * Resolves `false` when nothing was renamed (the reason has been shown).
 */
export async function renameBoard(boardId: string, name: string): Promise<boolean> {
  const next = name.trim();
  if (!next) return false;
  const problem = boardRenameProblem(boardId, next);
  if (problem) {
    uiStore.toast(problem, 'error');
    return false;
  }
  const oldPath = boardCacheStore.paths[boardId];
  if (!oldPath) {
    applyBoardName(boardId, next);
    return true;
  }
  const target = boardPathIn(parentFolder(oldPath), next);
  if (target !== oldPath) {
    const res = await vaultStore.rename(absPath(oldPath), absPath(target));
    if (!res.success) {
      uiStore.toast(`Couldn't rename the board file "${oldPath}"${res.code ? ` (${res.code})` : ''}.`, 'error');
      return false;
    }
  }
  applyBoardName(boardId, next);

  const folder = folderFollowingRename(
    oldPath,
    boardNameFromPath(oldPath),
    vaultStore.project?.settings?.general?.boardFolders === true,
  );
  if (!folder) return true;
  const newFolder = renamedFolder(folder, next);
  if (newFolder === folder) return true;
  if (!samePath(newFolder, folder) && directoryExistsInTree(vaultStore.rawTree ?? [], absPath(newFolder))) {
    uiStore.toast(`The board's folder "${folder}" kept its name: "${newFolder}" already exists.`, 'info');
    return true;
  }
  const res = await vaultStore.rename(absPath(folder), absPath(newFolder));
  if (!res.success) {
    uiStore.toast(`The board was renamed, but its folder "${folder}" couldn't be${res.code ? ` (${res.code})` : ''}.`, 'error');
  }
  return true;
}

export function setBoardEmoji(boardId: string, emoji: string): void {
  boardCacheStore.updateBoardIdentity(boardId, { emoji });
  const listed = vaultStore.project?.boards.find((b) => b.id === boardId);
  if (listed) listed.emoji = emoji;
  for (const tab of tabStore.tabs) {
    if (tab.boardId === boardId) tabStore.setEmoji(tab.id, emoji);
  }
}

/**
 * A `.board.json` renamed anywhere (sidebar, another program, the board's
 * own rename) renames the board to the new file stem. Runs from the rename
 * cascades, after the board's path has followed the file.
 */
function followBoardFileRename(_oldRel: string, newRel: string): void {
  for (const [boardId, path] of Object.entries(boardCacheStore.paths)) {
    // The board's path has already moved: it is `newRel`, or under it.
    if (rebasePath(path, newRel, newRel) === null) continue;
    applyBoardName(boardId, boardNameFromPath(path));
  }
}

/** Installs the rename sweep. Called once at startup (App.svelte). */
export function registerBoardNamesFollowFiles(): void {
  registerPathRenamable('boardIdentity.names', followBoardFileRename);
}
