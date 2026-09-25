/**
 * Moving the files a delete command removes into Filo's trash, and back on
 * undo. Commands keep only the trash id of each file, never its content: the
 * file itself waits in `.filo/trash` until undo or Settings → Trash restores
 * it, whatever its type or size.
 */
import { noteStore } from '../stores/notes.svelte';
import { uiStore } from '../stores/ui.svelte';
import { reindexUnder, syncAfterRestore } from '../stores/trash.svelte';
import { restoreTrashed, trashVaultPath } from '../lib/vault/vaultOperations';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { reportError } from '../lib/utils/errorBus';

/** A file or folder the command moved into Filo's trash. */
export interface TrashedItem {
  /** Vault-relative path it had. */
  rel: string;
  trashId: string;
}

/** Where a restored item landed: its old path, or beside it when that was taken. */
export interface RestoredItem {
  rel: string;
  restoredPath: string;
}

/**
 * Moves each path into Filo's trash, one after the other. A path already gone
 * is skipped silently (the goal, "not here any more", holds); any other
 * failure is reported and the path stays where it is.
 */
export async function trashFiles(vaultRoot: string, rels: string[], context: string): Promise<TrashedItem[]> {
  const identity = captureVaultIdentity();
  const trashed: TrashedItem[] = [];
  for (const rel of rels) {
    if (!isStillSameVault(identity)) break;
    try {
      const result = await trashVaultPath(vaultRoot, rel);
      if (result.success) {
        trashed.push({ rel, trashId: result.trashId });
        continue;
      }
      if (result.code === 'ENOENT') continue;
      reportError(context, new Error(result.error ?? result.code ?? 'vault:trash-move failed'), `Couldn't move "${rel}" to Filo's trash; it was not deleted.`);
    } catch (err) {
      reportError(context, err, `Couldn't move "${rel}" to Filo's trash; it was not deleted.`);
    }
  }
  if (!isStillSameVault(identity)) return trashed;
  for (const item of trashed) {
    // Nothing queued for these notes may recreate them, and their open views
    // show them as missing.
    noteStore.forgetDeleted(item.rel);
    await reindexUnder(item.rel);
  }
  return trashed;
}

/**
 * Moves each trashed item back. An item that is no longer in the trash but is
 * on disk at its old path (restored from Settings → Trash meanwhile) counts as
 * restored. Returns where each item landed; the others are reported.
 */
export async function restoreFiles(vaultRoot: string, items: TrashedItem[], context: string): Promise<RestoredItem[]> {
  const identity = captureVaultIdentity();
  const restored: RestoredItem[] = [];
  const failed: string[] = [];
  for (const item of items) {
    if (!isStillSameVault(identity)) return restored;
    try {
      const result = await restoreTrashed(vaultRoot, item.trashId, item.rel);
      if (result.success) {
        restored.push({ rel: item.rel, restoredPath: result.restoredPath });
        continue;
      }
      if (result.code === 'TRASH_ITEM_MISSING') {
        const back = await window.filo.invoke('vault:file-exists', vaultRoot, item.rel).catch(() => false);
        if (back) {
          restored.push({ rel: item.rel, restoredPath: item.rel });
          continue;
        }
      }
      failed.push(item.rel);
      reportError(context, new Error(result.error ?? result.code ?? 'vault:trash-restore failed'), `Couldn't restore "${item.rel}" from Filo's trash.`);
    } catch (err) {
      failed.push(item.rel);
      reportError(context, err, `Couldn't restore "${item.rel}" from Filo's trash.`);
    }
  }
  if (!isStillSameVault(identity)) return restored;
  if (restored.length > 0) await syncAfterRestore(restored.map((r) => r.restoredPath), identity);
  const moved = restored.filter((r) => r.restoredPath !== r.rel);
  if (moved.length > 0) {
    uiStore.toast(
      `Restored beside ${moved.length === 1 ? 'a file' : `${moved.length} files`} now using the old name: ${moved.map((m) => `"${m.restoredPath}"`).join(', ')}.`,
      'info',
      6000,
    );
  }
  return restored;
}

/** `path` with its `from` prefix (a file, or a folder above it) replaced by `to`. */
export function retargetPath(path: string, from: string, to: string): string {
  if (from === to) return path;
  const lower = path.toLowerCase();
  const fromLower = from.toLowerCase();
  if (lower === fromLower) return to;
  if (lower.startsWith(`${fromLower}/`)) return to + path.slice(from.length);
  return path;
}
