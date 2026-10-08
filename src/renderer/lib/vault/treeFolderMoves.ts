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
  /** Every file below it: path relative to the folder, case-folded, to its size. */
  files: Map<string, number | undefined>;
}

/** Every folder in `nodes`, keyed by its case-folded vault-relative path. */
function foldersOf(nodes: FileTreeNode[], rootAbs: string): Map<string, FolderInfo> {
  const out = new Map<string, FolderInfo>();
  const visit = (node: FileTreeNode): Map<string, number | undefined> => {
    if (!node.isDirectory) return new Map([[normalizeVaultRelative(node.name), node.sizeBytes]]);
    const files = new Map<string, number | undefined>();
    for (const child of node.children ?? []) {
      const prefix = child.isDirectory ? `${normalizeVaultRelative(child.name)}/` : '';
      for (const [name, size] of visit(child)) files.set(prefix + name, size);
    }
    const rel = toVaultRelative(node.path, rootAbs);
    if (rel) out.set(normalizeVaultRelative(rel), { rel, files });
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
 * Whether `arrived` can be `gone` moved: every file `gone` held is there by
 * name. Files added in the same moment (an agent renaming a folder and
 * writing a new note into it) and files changed in it (the same agent fixing
 * their links) don't stop the pairing: the watcher's walk can't follow those
 * changed notes either, since their new paths are already known to it as
 * files by then, so this is their one quick way to be followed.
 *
 * DECISION: a folder deleted while another arrives holding files of the same
 * names, between two tree reads, is followed as a move too: tiles of its
 * files then show the new ones. A tile can be re-linked, whereas a missed move
 * of an open note asks "deleted?" about a note that only moved.
 */
function couldBeMovedTo(gone: FolderInfo, arrived: FolderInfo): boolean {
  for (const name of gone.files.keys()) {
    if (!arrived.files.has(name)) return false;
  }
  return true;
}

/** The same files, by name and size, and no others. */
function sameFiles(a: FolderInfo, b: FolderInfo): boolean {
  if (a.files.size !== b.files.size) return false;
  for (const [name, size] of a.files) {
    if (!b.files.has(name) || b.files.get(name) !== size) return false;
  }
  return true;
}

/** The one arrived folder `gone` became: the one holding exactly its files, else the only one that could be it. */
function targetOf(gone: FolderInfo, arrived: FolderInfo[]): FolderInfo | null {
  const fits = arrived.filter((a) => couldBeMovedTo(gone, a));
  const exact = fits.filter((a) => sameFiles(gone, a));
  if (exact.length > 0) return exact.length === 1 ? (exact[0] ?? null) : null;
  return fits.length === 1 ? (fits[0] ?? null) : null;
}

/**
 * Each folder that left the tree while a folder holding its files arrived
 * (`couldBeMovedTo`; one holding exactly its files first): a rename or a
 * move. A folder with no files is never paired, and neither is one that two
 * folders on the other side could be, or that could be two: a missed pairing
 * only leaves a pin to be cleared (or the walk to follow it), while a wrong
 * one would re-point tiles at another folder's files.
 */
export function folderMovesBetween(
  before: FileTreeNode[],
  after: FileTreeNode[],
  rootAbs: string,
): Array<{ oldFolder: string; newFolder: string }> {
  const was = foldersOf(before, rootAbs);
  const now = foldersOf(after, rootAbs);
  const gone = topOnlyIn(was, now).filter((f) => f.files.size > 0);
  const arrived = topOnlyIn(now, was).filter((f) => f.files.size > 0);
  const targets = new Map(gone.map((g) => [g, targetOf(g, arrived)]));
  const moves: Array<{ oldFolder: string; newFolder: string }> = [];
  for (const [g, a] of targets) {
    if (!a || [...targets.values()].filter((t) => t === a).length !== 1) continue;
    moves.push({ oldFolder: g.rel, newFolder: a.rel });
  }
  return moves;
}
