/**
 * Folder renames read off two reads of the vault tree.
 *
 * On Windows `fs.watch` reports a folder renamed by another program as the
 * old and the new folder name only. The per-file renames inside it come much
 * later, from the watcher's periodic walk. By then the tree reconcile has
 * already found the old folder missing: a pin on it was cleared, and a board
 * file inside it looked deleted. Comparing the tree before and after a
 * refresh finds the move at once.
 */

import type { FileTreeNode } from '../../../shared/types';
import { normalizeVaultRelative, toVaultRelative } from '../utils/path';

interface FolderInfo {
  /** Vault-relative path, as spelled on disk. */
  rel: string;
  /** Every file below it: path relative to the folder and size, case-folded, sorted. */
  signature: string;
}

/** Every folder in `nodes`, keyed by its case-folded vault-relative path. */
function foldersOf(nodes: FileTreeNode[], rootAbs: string): Map<string, FolderInfo> {
  const out = new Map<string, FolderInfo>();
  const visit = (node: FileTreeNode): string[] => {
    if (!node.isDirectory) {
      return [`${normalizeVaultRelative(node.name)}\t${node.sizeBytes ?? ''}`];
    }
    const files: string[] = [];
    for (const child of node.children ?? []) {
      const prefix = child.isDirectory ? `${normalizeVaultRelative(child.name)}/` : '';
      for (const f of visit(child)) files.push(prefix + f);
    }
    const rel = toVaultRelative(node.path, rootAbs);
    if (rel) out.set(normalizeVaultRelative(rel), { rel, signature: files.sort().join('\n') });
    return files;
  };
  for (const n of nodes) visit(n);
  return out;
}

/** The folders in `a` and not in `b` whose parent is in `b` (or is the vault root). */
function topOnlyIn(a: Map<string, FolderInfo>, b: Map<string, FolderInfo>): FolderInfo[] {
  const out: FolderInfo[] = [];
  for (const [key, info] of a) {
    if (b.has(key)) continue;
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
    if (parent && !b.has(parent)) continue;
    out.push(info);
  }
  return out;
}

/**
 * Each folder that left the tree while a folder holding exactly the same
 * files (names and sizes) arrived: a rename or a move. A folder with no files
 * is never paired, and a signature shared by two candidates on either side is
 * ambiguous, so it isn't either: a missed pairing only leaves a pin to be
 * cleared, while a wrong one would re-point tiles at another folder's files.
 */
export function folderMovesBetween(
  before: FileTreeNode[],
  after: FileTreeNode[],
  rootAbs: string,
): Array<{ oldFolder: string; newFolder: string }> {
  const was = foldersOf(before, rootAbs);
  const now = foldersOf(after, rootAbs);
  const gone = topOnlyIn(was, now).filter((f) => f.signature !== '');
  const arrived = topOnlyIn(now, was).filter((f) => f.signature !== '');
  const count = (list: FolderInfo[], sig: string): number => list.filter((f) => f.signature === sig).length;
  const moves: Array<{ oldFolder: string; newFolder: string }> = [];
  for (const g of gone) {
    if (count(gone, g.signature) !== 1 || count(arrived, g.signature) !== 1) continue;
    const a = arrived.find((f) => f.signature === g.signature);
    if (a) moves.push({ oldFolder: g.rel, newFolder: a.rel });
  }
  return moves;
}
