import type {
  FileTreeNode,
  VaultSortField,
  VaultSortDirection,
  VaultGroupField,
} from '../../../shared/types';
import { normalizePath, toVaultRelative } from '../utils/path';
import { naturalCompare } from '../utils/naturalSort';

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

/** A file's type for sorting and grouping: a board apart from other JSON, else its extension. */
function typeKey(node: FileTreeNode): string {
  if (/\.board\.json$/i.test(node.name)) return '.board.json';
  return (node.extension ?? '').toLowerCase();
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
    return naturalCompare(a.name, b.name) * m;
  }
  switch (field) {
    case 'none':
      // 'none' is handled at the sortTree level (manual order); within the
      // comparator it's a no-op so nodes stay in input order.
      return 0;
    case 'name':
      return naturalCompare(a.name, b.name) * m;
    case 'modified':
      return ((a.modifiedAt ?? 0) - (b.modifiedAt ?? 0)) * m;
    case 'size':
      return ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)) * m;
    case 'type': {
      const c = naturalCompare(typeKey(a), typeKey(b));
      // Tie-break on name so files with the same extension are stable.
      return (c !== 0 ? c : naturalCompare(a.name, b.name)) * m;
    }
  }
}

// File Explorer's size groups: Empty, Tiny, Small, Medium, Large, Huge, Gigantic.
const SIZE_GROUP_LIMITS = [0, 16 * 1024, 1024 * 1024, 128 * 1024 * 1024, 1024 ** 3, 4 * 1024 ** 3];

/**
 * The group a file falls in under Group By. Groups are wider than the Sort
 * By field they share a name with, as File Explorer's are: names by their
 * first letter, dates by day, sizes by Explorer's size bands, types by
 * extension (a board apart from other JSON).
 */
function groupKey(node: FileTreeNode, field: Exclude<VaultGroupField, 'none'>): string | number {
  switch (field) {
    case 'name': {
      const first = node.name.normalize('NFD').charAt(0).toUpperCase();
      return /\p{L}/u.test(first) ? first : '#';
    }
    case 'modified': {
      const d = new Date(node.modifiedAt ?? 0);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }
    case 'size': {
      const size = node.sizeBytes ?? 0;
      const band = SIZE_GROUP_LIMITS.findIndex((limit) => size <= limit);
      return band < 0 ? SIZE_GROUP_LIMITS.length : band;
    }
    case 'type':
      return typeKey(node);
  }
}

function compareGroups(
  a: FileTreeNode,
  b: FileTreeNode,
  field: Exclude<VaultGroupField, 'none'>,
  direction: VaultSortDirection,
): number {
  const ka = groupKey(a, field);
  const kb = groupKey(b, field);
  const c = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : naturalCompare(String(ka), String(kb));
  return direction === 'asc' ? c : -c;
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
  // for the parent. Children the user never placed fall to the bottom, by
  // name in natural order ("Chapter 2" before "Chapter 10"), so a
  // newly-arrived file is visible without curation, and a folder never
  // reordered by hand reads as File Explorer lists it (not in the raw
  // listing's order, which puts 10 before 2).
  // allow-string-path-key: keys are absolute file-tree node paths from `n.path`, not vault-relative
  const indexByPath = new Map<string, number>();
  (orderForParent ?? []).forEach((p, i) => indexByPath.set(normalizePath(p), i));
  const decorated = nodes.map((n) => ({ n, rank: indexByPath.get(normalizePath(n.path)) }));
  decorated.sort((a, b) => {
    if (a.n.isDirectory && !b.n.isDirectory) return -1;
    if (!a.n.isDirectory && b.n.isDirectory) return 1;
    if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
    if (a.rank !== undefined) return -1;
    if (b.rank !== undefined) return 1;
    return naturalCompare(a.n.name, b.n.name);
  });
  return decorated.map((d) => d.n);
}

export function sortTree(nodes: FileTreeNode[], cfg: SortConfig, parentAbs: string = ''): FileTreeNode[] {
  let sorted: FileTreeNode[];
  const groupField = cfg.groupField;
  // Files are listed group by group, each group in the Sort By order (the
  // manual order under "None"); folders lead, by name.
  const byGroup = (a: FileTreeNode, b: FileTreeNode): number =>
    groupField === 'none' || a.isDirectory || b.isDirectory ? 0 : compareGroups(a, b, groupField, cfg.groupDirection);
  if (cfg.sortField === 'none') {
    const key = parentKey(parentAbs);
    const orderForParent = cfg.manualOrder?.[key];
    sorted = applyManualOrder(nodes, orderForParent);
    // A stable sort keeps the manual order inside each group.
    if (groupField !== 'none') sorted.sort(byGroup);
  } else {
    sorted = [...nodes].sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      const group = byGroup(a, b);
      if (group !== 0) return group;
      const primary = compareByField(a, b, cfg.sortField, cfg.sortDirection);
      // Equal dates or sizes fall back to the name, so the order is the same every time.
      return primary !== 0 ? primary : naturalCompare(a.name, b.name);
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

/** A note's title for the sidebar's search, or null for a file that has none. */
export type SearchTitleOf = (node: FileTreeNode) => string | null;

/** Whether the search `lower` (lower-cased) finds `node`: its name, or a note's title. */
function nodeMatchesSearch(node: FileTreeNode, lower: string, titleOf?: SearchTitleOf): boolean {
  if (node.name.toLowerCase().includes(lower)) return true;
  if (node.isDirectory || !titleOf) return false;
  return titleOf(node)?.toLowerCase().includes(lower) ?? false;
}

/**
 * The sidebar's search: files whose name (or, for a note, title) holds
 * `query` (any case) and the folders above them, plus every folder whose own
 * name holds it, shown whole (a search for a folder is a search for what is
 * in it). The sidebar lists file names, so a note titled "The Siege" in
 * `New Card (7).md` is still found by what the user called it.
 */
export function filterTree(nodes: FileTreeNode[], query: string, titleOf?: SearchTitleOf): FileTreeNode[] {
  if (!query) return nodes;
  const lower = query.toLowerCase();
  return nodes.reduce<FileTreeNode[]>((acc, node) => {
    if (node.isDirectory) {
      if (node.name.toLowerCase().includes(lower)) {
        acc.push(node);
        return acc;
      }
      const filteredChildren = filterTree(node.children ?? [], query, titleOf);
      if (filteredChildren.length > 0) acc.push({ ...node, children: filteredChildren });
    } else if (nodeMatchesSearch(node, lower, titleOf)) {
      acc.push(node);
    }
    return acc;
  }, []);
}

/**
 * The folders a search shows open: each folder whose name holds `query`, and
 * each folder above a file or folder that the search finds. A folder inside
 * a matching folder with no match of its own starts closed, so a match on a
 * big folder doesn't open everything under it.
 */
export function foldersOpenForSearch(nodes: readonly FileTreeNode[], query: string, titleOf?: SearchTitleOf): Set<string> {
  const lower = query.toLowerCase();
  const open = new Set<string>();
  const walk = (node: FileTreeNode): boolean => {
    const self = nodeMatchesSearch(node, lower, titleOf);
    if (!node.isDirectory) return self;
    let below = false;
    for (const child of node.children ?? []) if (walk(child)) below = true;
    if (self || below) open.add(node.path);
    return self || below;
  };
  for (const node of nodes) walk(node);
  return open;
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
  function walk(node: FileTreeNode) {
    const rel = toVaultRelative(node.path, rootAbs);
    if (!node.isDirectory && rel) out.add(rel);
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
