/**
 * Filo's trash (`.filo/trash`) as the app sees it: the Settings → Trash list,
 * restoring from it, emptying it into the OS Recycle Bin, and the 30-day purge
 * on vault open.
 *
 * Deletes and undo live with their commands and cascades; they call
 * `trashVaultPath` / `restoreTrashed` directly and `syncAfterRestore` here once
 * something is back on disk.
 */
import type { TrashEntryInfo } from '@shared/ipcContracts';
import type { FileTreeNode } from '../../shared/types';
import { uiStore } from './ui.svelte';
import { vaultStore } from './vault.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { noteStore } from './notes.svelte';
import { themeStore } from './theme.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';
import {
  deleteTrashPermanently,
  listTrash,
  purgeTrash,
  restoreTrashed,
} from '../lib/vault/vaultOperations';
import { captureVaultIdentity, isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';
import { reportError } from '../lib/utils/errorBus';
import { toVaultRelative } from '../lib/utils/path';
import { vaultPath } from '../../shared/vaultPath';

let entries = $state<TrashEntryInfo[]>([]);
let thisMachine = $state('');
let loaded = $state(false);
let busy = $state(false);

/** Vault-relative paths of every file in `tree` at or under `rel`. */
function filesUnder(tree: FileTreeNode[], vaultRoot: string, rel: string): string[] {
  const key = rel.toLowerCase();
  const out: string[] = [];
  const walk = (nodes: FileTreeNode[]): void => {
    for (const n of nodes) {
      const nodeRel = toVaultRelative(n.path, vaultRoot);
      if (!nodeRel) continue;
      const lower = nodeRel.toLowerCase();
      if (!n.isDirectory && (lower === key || lower.startsWith(`${key}/`))) out.push(nodeRel);
      if (n.children && (lower === key || key.startsWith(`${lower}/`) || lower.startsWith(`${key}/`))) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/**
 * Brings the app up to date with items that just came back from the trash
 * (files or folders, vault-relative): the sidebar tree (which also adopts a
 * restored board), the search index, any open note that was showing as
 * missing, and the theme list for a restored theme. The watcher doesn't
 * report our own restores.
 */
export async function syncAfterRestore(rels: string[], identity: VaultIdentity): Promise<void> {
  await vaultStore.enqueueRenameQueueWork(() => vaultStore.refreshTreeAndCleanup());
  if (!isStillSameVault(identity)) return;
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  if (rels.some((rel) => rel.toLowerCase().startsWith('.filo/themes/'))) {
    await themeStore.refreshAvailable(vaultRoot);
    if (!isStillSameVault(identity)) return;
  }
  const files = rels.flatMap((rel) => filesUnder(vaultStore.rawTree, vaultRoot, rel));
  await vaultIndexStore.applyChanges(files);
  if (!isStillSameVault(identity)) return;
  for (const rel of rels) noteStore.restoredFromTrash(rel);
}

/**
 * Search-index entries at or under `rel` are read again, which drops the ones
 * whose files just went to the trash. The watcher doesn't report our own moves.
 */
export async function reindexUnder(rel: string): Promise<void> {
  const key = rel.toLowerCase();
  const paths = vaultIndexStore
    .allMetadata()
    .map((m) => m.path)
    .filter((p) => p.toLowerCase() === key || p.toLowerCase().startsWith(`${key}/`));
  await vaultIndexStore.applyChanges(paths);
}

/**
 * Asks before deleting for good the items the Recycle Bin refused. This is the
 * only place Filo deletes user content permanently.
 */
async function offerPermanentDelete(
  vaultRoot: string,
  failed: Array<{ trashId: string; originalPath: string }>,
  identity: VaultIdentity,
): Promise<void> {
  const list = failed.map((f) => `• ${f.originalPath}`).join('\n');
  const ok = await uiStore.confirmAsync({
    title: 'Delete permanently?',
    body: `The Recycle Bin couldn't take ${failed.length === 1 ? 'this item' : `these ${failed.length} items`} from Filo's trash:\n${list}\n\nDelete ${failed.length === 1 ? 'it' : 'them'} permanently? This can't be undone. Cancel keeps ${failed.length === 1 ? 'it' : 'them'} in Filo's trash.`,
    confirmLabel: 'Delete permanently',
    cancelLabel: 'Keep in trash',
    danger: true,
  });
  if (!ok || !isStillSameVault(identity)) return;
  const result = await deleteTrashPermanently(vaultRoot, failed.map((f) => f.trashId));
  if (!result.success) {
    reportError('trash.deletePermanently', new Error(result.error ?? result.code ?? 'failed'), "Couldn't delete the trashed items.");
  }
}

async function handlePurge(
  vaultRoot: string,
  which: string[] | 'olderThan30d',
  identity: VaultIdentity,
): Promise<number> {
  const result = await purgeTrash(vaultRoot, which);
  if (!isStillSameVault(identity)) return 0;
  if (result.success) return result.purged.length;
  if ('failed' in result && result.code === 'TRASH_FAILED') {
    await offerPermanentDelete(vaultRoot, result.failed, identity);
    return result.purged.length;
  }
  reportError('trash.purge', new Error(result.error ?? result.code ?? 'failed'), "Couldn't empty Filo's trash.");
  return 0;
}

/**
 * On vault open: this machine's trashed items older than 30 days go to the
 * Recycle Bin. Best-effort; never blocks the open.
 */
export async function purgeExpiredTrash(vaultRoot: string, identity: VaultIdentity): Promise<void> {
  if (!vaultRoot) return;
  try {
    await handlePurge(vaultRoot, 'olderThan30d', identity);
  } catch (err) {
    reportError('trash.purgeExpired', err, "Couldn't tidy Filo's trash");
  }
}

/**
 * "Moved to Filo's trash" with an Undo button, for a delete no board undo
 * stack holds (a board file, whose history goes with it; a sidebar delete with
 * no board open). `undo` puts it back.
 */
export function toastMovedToTrash(label: string, undo: () => Promise<void>): void {
  const identity = captureVaultIdentity();
  uiStore.pushToast({
    text: `"${label}" was moved to Filo's trash.`,
    type: 'info',
    duration: 10000,
    actions: [
      {
        label: 'Undo',
        handler: async () => {
          if (!isStillSameVault(identity)) return;
          await undo();
        },
      },
    ],
  });
}

/** Moves one trashed item back and brings the app up to date (the toast's Undo for a board file). */
export async function restoreTrashedItem(label: string, rel: string, trashId: string): Promise<void> {
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  const identity = captureVaultIdentity();
  const result = await restoreTrashed(vaultRoot, trashId, rel);
  if (!isStillSameVault(identity)) return;
  if (!result.success) {
    uiStore.toast(`Couldn't restore "${label}"${result.error ? `: ${result.error}` : ''}.`, 'error', 6000);
    return;
  }
  await syncAfterRestore([result.restoredPath], identity);
}

export const trashStore = {
  get entries(): TrashEntryInfo[] { return entries; },
  get loaded(): boolean { return loaded; },
  /** This machine's id: entries from other machines are purged only there. */
  get thisMachine(): string { return thisMachine; },
  get busy(): boolean { return busy; },

  /**
   * The newest trashed item that holds `rel` (the file itself, or a folder
   * it was in), if it's still in the trash. Case-folded, like every path key.
   */
  entryHolding(rel: string): TrashEntryInfo | undefined {
    const key = vaultPath(rel);
    let best: TrashEntryInfo | undefined;
    for (const e of entries) {
      if (!e.present) continue;
      const at = vaultPath(e.originalPath);
      if (at !== key && !key.startsWith(`${at}/`)) continue;
      if (!best || Date.parse(e.deletedAt) > Date.parse(best.deletedAt)) best = e;
    }
    return best;
  },

  async refresh(): Promise<void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    const identity = captureVaultIdentity();
    try {
      const result = await listTrash(vaultRoot);
      if (!isStillSameVault(identity)) return;
      if (!result.success) throw new Error(result.error ?? result.code ?? 'failed');
      entries = result.entries;
      thisMachine = result.machineId;
      loaded = true;
    } catch (err) {
      reportError('trash.list', err, "Couldn't read Filo's trash.");
    }
  },

  /** Puts one item back where it was (or beside it when that path is taken). */
  async restore(entry: TrashEntryInfo): Promise<void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot || busy) return;
    const identity = captureVaultIdentity();
    busy = true;
    try {
      const result = await restoreTrashed(vaultRoot, entry.trashId, entry.originalPath);
      if (!isStillSameVault(identity)) return;
      if (!result.success) {
        uiStore.toast(
          result.code === 'TRASH_ITEM_MISSING'
            ? `"${entry.originalPath}" is no longer in Filo's trash.`
            : `Couldn't restore "${entry.originalPath}"${result.error ? `: ${result.error}` : ''}.`,
          'error',
          6000,
        );
        return;
      }
      await syncAfterRestore([result.restoredPath], identity);
      uiStore.toast(
        result.alongside
          ? `Restored as "${result.restoredPath}" (the original name is taken).`
          : `Restored "${result.restoredPath}".`,
        'success',
        4000,
      );
    } catch (err) {
      reportError('trash.restore', err, `Couldn't restore "${entry.originalPath}".`);
    } finally {
      busy = false;
      await this.refresh();
    }
  },

  /** Sends everything in Filo's trash to the Recycle Bin, after a confirm. */
  async empty(): Promise<void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot || busy || entries.length === 0) return;
    const count = entries.length;
    const ok = await uiStore.confirmAsync({
      title: "Empty Filo's trash?",
      body: `${count} item${count === 1 ? '' : 's'} will be moved to the Recycle Bin. Filo can't restore ${count === 1 ? 'it' : 'them'} after that; the Recycle Bin can.`,
      confirmLabel: 'Empty trash',
      danger: true,
    });
    if (!ok) return;
    const identity = captureVaultIdentity();
    busy = true;
    try {
      await handlePurge(vaultRoot, entries.map((e) => e.trashId), identity);
    } catch (err) {
      reportError('trash.empty', err, "Couldn't empty Filo's trash.");
    } finally {
      busy = false;
      await this.refresh();
    }
  },
};

onVaultSwap('pre-swap', 'trash', () => {
  entries = [];
  loaded = false;
  busy = false;
});
