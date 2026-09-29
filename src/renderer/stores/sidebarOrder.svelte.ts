/**
 * sidebarOrder — the manual sidebar order (Sort By "None"), saved in
 * `.filo/sidebar-order.json`.
 *
 * Keyed by parent folder (vault root = ''); each value is the children
 * in the order the user dragged them. The file holds vault-relative paths, the
 * store absolute ones as the tree spells them. Loaded at vault open and saved on the
 * misc writer's 300 ms idle debounce. Another copy of the file (a sync
 * client, another machine) is merged per folder: a folder reordered in this
 * session keeps this session's order, and every other folder takes the file's.
 */
import { scheduleMiscWrite } from '../lib/boards/miscWriteScheduler';
import { objectEntries, readOutsideVersion, saveMiscConfig } from '../lib/boards/miscConfigDrift';
import { normalizePath, samePath, toVaultRelative } from '../lib/utils/path';
import { onVaultSwap } from '../core/vaultLifecycle';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';

const SIDEBAR_ORDER_KEY = 'config:.filo/sidebar-order.json';
const SIDEBAR_ORDER_PATH = '.filo/sidebar-order.json';

let manualOrder = $state<Record<string, string[]>>({});
/** Folders reordered this session: a merge keeps their order. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- read only by the merge, never rendered
const changedFolders = new Set<string>();
onVaultSwap('pre-swap', 'sidebarOrder', () => {
  manualOrder = {};
  changedFolders.clear();
}, { runAfter: ['leftBehind'] });

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Hand-edited shapes are dropped: only folder → list of paths is kept. */
export function sanitizeSidebarOrder(raw: unknown): Record<string, string[]> {
  return Object.fromEntries(objectEntries(raw, isStringList));
}

/** The key a folder's order is kept under in memory: '' for the vault root, as the tree reads it. */
function folderKey(parentAbs: string, vaultRoot: string): string {
  const key = normalizePath(parentAbs);
  return vaultRoot !== '' && samePath(key, normalizePath(vaultRoot)) ? '' : key;
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/;

/** A path from the file as the tree spells it: absolute, forward slashes. */
function absoluteIn(p: string, vaultRoot: string): string {
  if (ABSOLUTE.test(p) || vaultRoot === '') return normalizePath(p);
  return `${normalizePath(vaultRoot)}/${normalizePath(p)}`;
}

/** A path as the file holds it: relative to the vault, so the order survives the vault moving or syncing to another machine. */
function relativeIn(p: string, vaultRoot: string): string {
  return toVaultRelative(p, vaultRoot) ?? normalizePath(p);
}

/**
 * The file's order as the tree reads it: absolute paths, the top level under
 * ''. The file holds vault-relative paths; one written before that holds
 * absolute ones, read as they are (a path outside this vault matches
 * nothing). A top-level order saved under the vault's own path (where the tree
 * never read it) is taken as the root's unless one is already under ''.
 */
function fromFile(order: Record<string, string[]>, vaultRoot: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let fromPath: string[] | undefined;
  for (const [key, list] of Object.entries(order)) {
    const items = list.map((p) => absoluteIn(p, vaultRoot));
    if (key === '') { out[''] = items; continue; }
    const memKey = folderKey(absoluteIn(key, vaultRoot), vaultRoot);
    if (memKey === '') fromPath = items;
    else out[memKey] = items;
  }
  if (fromPath && !out['']) out[''] = fromPath;
  return out;
}

/** The order as the file holds it (vault-relative). */
function toFile(order: Record<string, string[]>, vaultRoot: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(order)) {
    out[key === '' ? '' : relativeIn(key, vaultRoot)] = list.map((p) => relativeIn(p, vaultRoot));
  }
  return out;
}

/** Takes another copy of the file in, keeping this session's reordered folders. */
export function mergeSidebarOrderFromDisk(disk: unknown): void {
  const merged: Record<string, string[]> = fromFile(sanitizeSidebarOrder(disk), getActiveVaultPath());
  for (const key of changedFolders) {
    const local = manualOrder[key];
    if (local) merged[key] = local;
  }
  manualOrder = merged;
}

function scheduleSidebarOrderWrite(vaultRoot: string): void {
  scheduleMiscWrite(SIDEBAR_ORDER_KEY, () => ({
    vaultRoot,
    path: SIDEBAR_ORDER_PATH,
    json: JSON.stringify(toFile(manualOrder, vaultRoot), null, 2),
    droppable: true,
    write: async () => {
      const outside = await readOutsideVersion(vaultRoot, 'sidebar-order.json');
      if (outside.kind === 'changed') mergeSidebarOrderFromDisk(outside.disk);
      await saveMiscConfig(vaultRoot, 'sidebar-order.json', JSON.stringify(toFile(manualOrder, vaultRoot), null, 2));
    },
  }));
}

export const sidebarOrderStore = {
  get order(): Record<string, string[]> {
    return manualOrder;
  },
  /** The order read at vault open. */
  seed(order: Record<string, string[]>, vaultRoot: string = getActiveVaultPath()): void {
    manualOrder = fromFile(order, vaultRoot);
    changedFolders.clear();
  },
  /** Reassigns the whole record so Svelte's reactive tracking fires. */
  set(vaultRoot: string, parentAbs: string, orderedChildPaths: string[]): void {
    const key = folderKey(parentAbs, vaultRoot);
    manualOrder = { ...manualOrder, [key]: orderedChildPaths.map((p) => normalizePath(p)) };
    changedFolders.add(key);
    scheduleSidebarOrderWrite(vaultRoot);
  },
};
