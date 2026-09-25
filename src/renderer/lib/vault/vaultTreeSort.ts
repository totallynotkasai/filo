import type {
  FileTreeNode,
  VaultSortField,
  VaultSortDirection,
  VaultGroupField,
} from '../../../shared/types';
import { normalizePath, toPosix } from '../utils/path';

export interface SortConfig {
  sortField: VaultSortField;
  sortDirection: VaultSortDirection;
  groupField: VaultGroupField;
  groupDirection: VaultSortDirection;
  /**
   * User-defined sidebar order when `sortField === 'none'`. Keyed by the
   * parent folder's absolute path (vault root = `''`); each value is an
   * ordered list of child node paths. Unknown children fall to the bottom
   * of their parent in stable input order so files newly arrived on disk
   * stay visible without curation.
   */
  manualOrder?: Record<string, string[]>;
}

export function compareByField(
  a: FileTreeNode,
  b: FileTreeNode,
  field: VaultSortField,
  direction: VaultSortDirection,
): number {
  const m = direction === 'asc' ? 1 : -1;
  // Folders always sort by name — mtime/size are meaningless for directories.
  if (a.isDirectory && b.isDirectory) {
    return a.name.localeCompare(b.name) * m;
  }
  switch (field) {
    case 'none':
      // 'none' is handled at the sortTree level (manual order); within the
      // comparator it's a no-op so nodes stay in input order.
      return 0;
    case 'name':
      return a.name.localeCompare(b.name) * m;
    case 'modified':
      return ((a.modifiedAt ?? 0) - (b.modifiedAt ?? 0)) * m;
    case 'size':
      return ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)) * m;
    case 'type': {
      const ax = (a.extension ?? '').toLowerCase();
      const bx = (b.extension ?? '').toLowerCase();
      const c = ax.localeCompare(bx);
      // Tie-break on name so files with the same extension are stable.
      return (c !== 0 ? c : a.name.localeCompare(b.name)) * m;
    }
  }
}

/**
 * Returns the parent folder absolute path for a given child node, used as
 * the lookup key into `cfg.manualOrder`. The vault root uses the empty
 * string so the top-level array has a single, well-known key.
 */
function parentKey(parentAbs: string): string {
  return normalizePath(parentAbs);
}

function applyManualOrder(nodes: FileTreeNode[], orderForParent: string[] | undefined): FileTreeNode[] {
  // Folders first (matching every other sort path), then the manual order
  // for the parent. Unknown children fall to the bottom in stable input
  // order so a newly-arrived file is always visible without curation.
  if (!orderForParent || orderForParent.length === 0) {
    // Even with no manual order recorded, we still want folders to lead.
    const withFolders = [...nodes].sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return 0;
    });
    return withFolders;
  }
  // allow-string-path-key: keys are absolute file-tree node paths from `n.path`, not vault-relative
  const indexByPath = new Map<string, number>();
  orderForParent.forEach((p, i) => indexByPath.set(p, i));
  const unknownStart = orderForParent.length;
  const decorated = nodes.map((n, i) => {
    const known = indexByPath.get(n.path);
    return { n, rank: known !== undefined ? known : unknownStart + i };
  });
  decorated.sort((a, b) => {
    if (a.n.isDirectory && !b.n.isDirectory) return -1;
    if (!a.n.isDirectory && b.n.isDirectory) return 1;
    return a.rank - b.rank;
  });
  return decorated.map((d) => d.n);
}

export function sortTree(nodes: FileTreeNode[], cfg: SortConfig, parentAbs: string = ''): FileTreeNode[] {
  let sorted: FileTreeNode[];
  if (cfg.sortField === 'none') {
    const key = parentKey(parentAbs);
    const orderForParent = cfg.manualOrder?.[key];
    sorted = applyManualOrder(nodes, orderForParent);
  } else {
    sorted = [...nodes].sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      const primary = compareByField(a, b, cfg.sortField, cfg.sortDirection);
      if (primary !== 0) return primary;
      if (cfg.groupField === 'none') return 0;
      // Group acts as a secondary sort within equal primary-sort values.
      return compareByField(a, b, cfg.groupField, cfg.groupDirection);
    });
  }
  // Preserve node identity wherever children didn't change order/contents.
  // Without this, every reactive read of `tree` (and every refreshTree pass
  // that survived treesEqual) would allocate a fresh `{ ...node, children }`
  // for every directory, defeating Svelte's keyed-each reuse.
  let allSame = sorted.length === nodes.length;
  const next: FileTreeNode[] = new Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    const node = sorted[i];
    if (!node) continue; // i < sorted.length; narrow for the type-checker
    if (node.isDirectory && node.children) {
      const sortedChildren = sortTree(node.children, cfg, node.path);
      if (sortedChildren === node.children) {
        next[i] = node;
      } else {
        next[i] = { ...node, children: sortedChildren };
        allSame = false;
      }
    } else {
      next[i] = node;
    }
    if (allSame && nodes[i] !== node) allSame = false;
  }
  return allSame ? nodes : next;
}

export function filterTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  if (!query) return nodes;
  const lower = query.toLowerCase();
  return nodes.reduce<FileTreeNode[]>((acc, node) => {
    if (node.isDirectory) {
      const filteredChildren = filterTree(node.children ?? [], query);
      if (filteredChildren.length > 0) acc.push({ ...node, children: filteredChildren });
    } else if (node.name.toLowerCase().includes(lower)) {
      acc.push(node);
    }
    return acc;
  }, []);
}

/**
 * Structural equality on the raw file tree. Used to gate `fileTree = tree`
 * reassignment when the watcher fires `vault:tree-updated` after a write that
 * didn't actually change the on-disk structure (e.g. an in-place board JSON
 * save). Without this, every such fire allocates a fresh node graph that
 * propagates through every sidebar row's reactive deps and causes flicker.
 *
 * Compares structure only — `modifiedAt` and `sizeBytes` are intentionally
 * ignored. A mere mtime bump from an external save shouldn't re-render the
 * whole sidebar; if a tile/document needs the new mtime, it has its own
 * reactive path.
 */
export function treesEqual(a: FileTreeNode[], b: FileTreeNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false; // equal lengths + in-range; unequal is the safe direction
    if (x.path !== y.path) return false;
    if (x.isDirectory !== y.isDirectory) return false;
    if (x.name !== y.name) return false;
    const xc = x.children ?? [];
    const yc = y.children ?? [];
    if (!treesEqual(xc, yc)) return false;
  }
  return true;
}

export function flattenTreePaths(nodes: FileTreeNode[], rootAbs: string): Set<string> {
  const out = new Set<string>();
  const root = normalizePath(rootAbs).toLowerCase();
  function walk(node: FileTreeNode) {
    const rel = toPosix(node.path).toLowerCase();
    if (rel.startsWith(root + '/')) {
      const slice = toPosix(node.path).slice(root.length + 1);
      if (!node.isDirectory && slice) out.add(slice);
    }
    if (node.children) for (const child of node.children) walk(child);
  }
  for (const n of nodes) walk(n);
  return out;
}

export function directoryExistsInTree(nodes: FileTreeNode[], absPath: string): boolean {
  const target = normalizePath(absPath).toLowerCase();
  let found = false;
  function walk(n: FileTreeNode) {
    if (found) return;
    if (n.isDirectory) {
      const np = normalizePath(n.path).toLowerCase();
      if (np === target) {
        found = true;
        return;
      }
    }
    if (n.children) for (const c of n.children) walk(c);
  }
  for (const n of nodes) walk(n);
  return found;
}
