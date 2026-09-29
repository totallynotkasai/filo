/**
 * sidebarOrder — the manual sidebar order (Sort By "None"), saved in
 * `.filo/sidebar-order.json`.
 *
 * Keyed by parent folder path (vault root = ''); each value is the children
 * in the order the user dragged them. Loaded at vault open and saved on the
 * misc writer's 300 ms idle debounce. Another copy of the file (a sync
 * client, another machine) is merged per folder: a folder reordered in this
 * session keeps this session's order, and every other folder takes the file's.
 */
import { scheduleMiscWrite } from '../lib/boards/miscWriteScheduler';
import { objectEntries, readOutsideVersion, saveMiscConfig } from '../lib/boards/miscConfigDrift';
import { normalizePath, samePath } from '../lib/utils/path';
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
});

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Hand-edited shapes are dropped: only folder → list of paths is kept. */
export function sanitizeSidebarOrder(raw: unknown): Record<string, string[]> {
  return Object.fromEntries(objectEntries(raw, isStringList));
}

/** The key a folder's order is saved under: '' for the vault root, as the tree reads it. */
function folderKey(parentAbs: string, vaultRoot: string): string {
  const key = normalizePath(parentAbs);
  return vaultRoot !== '' && samePath(key, normalizePath(vaultRoot)) ? '' : key;
}

/**
 * The top-level order under '' only. A file may hold it under the vault's
 * own path (how it was once written, where the tree never read it); that
 * order is taken as the root's unless one is already under ''.
 */
function withRootKey(order: Record<string, string[]>, vaultRoot: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let fromPath: string[] | undefined;
  for (const [key, list] of Object.entries(order)) {
    if (folderKey(key, vaultRoot) === '' && key !== '') fromPath = list;
    else out[key] = list;
  }
  if (fromPath && !out['']) out[''] = fromPath;
  return out;
}

/** Takes another copy of the file in, keeping this session's reordered folders. */
export function mergeSidebarOrderFromDisk(disk: unknown): void {
  const merged: Record<string, string[]> = withRootKey(sanitizeSidebarOrder(disk), getActiveVaultPath());
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
    json: JSON.stringify(manualOrder, null, 2),
    droppable: true,
    write: async () => {
      const outside = await readOutsideVersion(vaultRoot, 'sidebar-order.json');
      if (outside.kind === 'changed') mergeSidebarOrderFromDisk(outside.disk);
      await saveMiscConfig(vaultRoot, 'sidebar-order.json', JSON.stringify(manualOrder, null, 2));
    },
  }));
}

export const sidebarOrderStore = {
  get order(): Record<string, string[]> {
    return manualOrder;
  },
  /** The order read at vault open. */
  seed(order: Record<string, string[]>, vaultRoot: string = getActiveVaultPath()): void {
    manualOrder = withRootKey(order, vaultRoot);
    changedFolders.clear();
  },
  /** Reassigns the whole record so Svelte's reactive tracking fires. */
  set(vaultRoot: string, parentAbs: string, orderedChildPaths: string[]): void {
    const key = folderKey(parentAbs, vaultRoot);
    manualOrder = { ...manualOrder, [key]: orderedChildPaths.slice() };
    changedFolders.add(key);
    scheduleSidebarOrderWrite(vaultRoot);
  },
};
