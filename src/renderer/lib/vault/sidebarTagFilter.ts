/**
 * Pure half of the sidebar tag filter: which files a tag selects, and the
 * file tree cut down to them.
 */
import type { FileTreeNode } from '../../../shared/types';
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';
import { toVaultRelative } from '../utils/path';

/** Tag identity is case-insensitive, folded in en-US like the tag registry. */
function foldTag(tag: string): string {
  return tag.replace(/^#/, '').toLocaleLowerCase('en-US');
}

/** Same tag, ignoring case (and a leading `#`). */
export function sameTag(a: string, b: string): boolean {
  return foldTag(a) === foldTag(b);
}

/**
 * True when `tag` is `filter` or one of its child tags: filtering by
 * `project` also selects `project/a`, but not `projects`.
 */
export function tagMatchesFilter(tag: string, filter: string): boolean {
  const t = foldTag(tag);
  const f = foldTag(filter);
  return f !== '' && (t === f || t.startsWith(f + '/'));
}

export interface TaggedFile {
  /** Vault-relative path. */
  path: string;
  tags: readonly string[];
}

/** The vault paths of every file carrying `filter` or one of its child tags. */
export function filesMatchingTag(filter: string, files: Iterable<TaggedFile>): Set<VaultPath> {
  const out = new Set<VaultPath>();
  for (const f of files) {
    if (f.tags.some((t) => tagMatchesFilter(t, filter))) out.add(vaultPath(f.path));
  }
  return out;
}

/**
 * The tree cut down to the files in `keep` and the folders above them. Tree
 * nodes carry absolute paths, so each is made vault-relative against
 * `vaultRoot` before the lookup. Returns new folder nodes; file nodes are
 * shared with the input.
 */
export function filterTreeToFiles(
  nodes: readonly FileTreeNode[],
  vaultRoot: string,
  keep: ReadonlySet<VaultPath>,
): FileTreeNode[] {
  const out: FileTreeNode[] = [];
  for (const node of nodes) {
    if (node.isDirectory) {
      const children = filterTreeToFiles(node.children ?? [], vaultRoot, keep);
      if (children.length > 0) out.push({ ...node, children });
      continue;
    }
    const rel = toVaultRelative(node.path, vaultRoot);
    if (rel !== null && keep.has(vaultPath(rel))) out.push(node);
  }
  return out;
}
