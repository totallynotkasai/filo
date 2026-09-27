/**
 * Folder moves seen by a tree read and not yet followed.
 *
 * Every tree read (`vaultStore.refreshTree`) notes the folder moves between
 * the tree it replaces and the one it read. The watcher's reconcile
 * (`refreshTreeAndCleanup`) takes and follows them. An in-app create, delete
 * or rename reads the tree directly, and can be the read that first sees a
 * folder another program renamed meanwhile; diffing only inside the
 * reconcile would then find nothing and leave the pins and tiles behind.
 *
 * A move Filo made itself (both paths marked as its own recent writes by the
 * in-app rename) is not noted: the rename's own cascade has followed it.
 */

import type { FileTreeNode } from '../../../shared/types';
import { onVaultSwap } from '../../core/vaultLifecycle';
import { isRecentSelfWrite } from '../boards/writeStateTracking';
import { folderMovesBetween } from './treeFolderMoves';

interface FolderMove {
  oldFolder: string;
  newFolder: string;
}

let unreconciled: FolderMove[] = [];

/** Notes the folder moves from `before` to `after` that Filo didn't make. */
export function noteFolderMoves(before: FileTreeNode[], after: FileTreeNode[], rootAbs: string): void {
  for (const move of folderMovesBetween(before, after, rootAbs)) {
    if (isRecentSelfWrite(move.oldFolder) && isRecentSelfWrite(move.newFolder)) continue;
    unreconciled.push(move);
  }
}

/** Every noted move, oldest first; the list is emptied. */
export function takeFolderMoves(): FolderMove[] {
  const moves = unreconciled;
  unreconciled = [];
  return moves;
}

// A move noted in one vault never names folders of the next.
onVaultSwap('pre-swap', 'unreconciledFolderMoves', () => {
  unreconciled = [];
});
