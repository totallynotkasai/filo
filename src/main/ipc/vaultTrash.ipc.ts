import { ipcMain, shell } from 'electron';
import { join } from 'path';
import { promises as fsPromises } from 'fs';
import { toPosix } from '../../shared/pathUtils';
import {
  assertSafeRelativePath,
  assertWithinVault,
  FiloDirForbiddenError,
} from '../utils/pathSecurity';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { getMachineIdentity } from '../services/machineIdentity';
import { LOCK_AWARE_SUPPRESS_MS } from '../vault/filenameUtils';
import {
  deleteTrashedPermanently,
  listTrash,
  moveToTrash,
  purgeTrash,
  restoreFromTrash,
  TrashIdError,
  TrashItemMissingError,
} from '../vault/trashOps';
import { getActiveWatcher } from './vault.ipc';
import { logMainError } from '../utils/mainLogger';
import { ipcErrorCode } from './ipcErrorCode';

/**
 * `.filo/trash` channels. Every user-facing delete in the renderer moves the
 * item here (`vault:trash-move`), and undo or Settings → Trash moves it back
 * (`vault:trash-restore`). See `vault/trashOps.ts` for the layout.
 */

function errorResult(err: unknown): { success: false; code: string; error: string } {
  if (err instanceof TrashItemMissingError) return { success: false, code: 'TRASH_ITEM_MISSING', error: err.message };
  if (err instanceof TrashIdError) return { success: false, code: 'FORBIDDEN', error: err.message };
  return { success: false, code: ipcErrorCode(err), error: String(err) };
}

/**
 * The watcher must not report our own move as a delete (a "deleted
 * externally" prompt) or a restore as a new file from another program. A
 * folder suppresses its whole tree.
 */
async function suppressWatcher(vaultRoot: string, rel: string, kind?: 'file' | 'folder'): Promise<void> {
  const watcher = getActiveWatcher();
  if (!watcher) return;
  let isDirectory = kind === 'folder';
  if (!kind) {
    try {
      isDirectory = (await fsPromises.stat(join(vaultRoot, ...rel.split('/')))).isDirectory();
    } catch {
      // Missing: nothing will be reported for it.
    }
  }
  if (isDirectory) watcher.suppressTree(rel, 5000);
  else watcher.suppress(rel, LOCK_AWARE_SUPPRESS_MS);
}

export function registerVaultTrashHandlers(): void {
  /** Moves a vault file or folder into `.filo/trash`. Nothing moves on failure. */
  ipcMain.handle('vault:trash-move', async (_event, vaultRoot: string, relPath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relPath);
      const rel = toPosix(relPath);
      // Filo's own files are never user content, and trashing the trash
      // would nest it.
      if (rel.split('/')[0]?.toLowerCase() === '.filo') {
        throw new FiloDirForbiddenError(`FORBIDDEN: ${rel} is inside .filo`);
      }
      assertWithinVault(vaultRoot, join(vaultRoot, ...rel.split('/')));
      await suppressWatcher(vaultRoot, rel);
      // The walk forgets the item until it comes back, so its next pass
      // doesn't report Filo's own move as a delete by another program.
      const watcher = getActiveWatcher();
      const moveDone = watcher?.beginOwnMove();
      try {
        const { trashId, kind } = await moveToTrash(vaultRoot, rel, getMachineIdentity().machineId);
        watcher?.noteOwnTrash(rel, trashId);
        return { success: true, trashId, kind };
      } finally {
        moveDone?.();
      }
    } catch (err) {
      const code = ipcErrorCode(err);
      if (code !== 'ENOENT') logMainError('vault:trash-move', err);
      return errorResult(err);
    }
  });

  /**
   * Moves a trashed item back: to its original path, or beside it
   * (`… (restored).md`) when that path is taken again.
   */
  ipcMain.handle('vault:trash-restore', async (_event, vaultRoot: string, trashId: string) => {
    try {
      assertActiveVault(vaultRoot);
      const entry = (await listTrash(vaultRoot)).find((e) => e.trashId === trashId);
      if (entry) {
        assertWithinVault(vaultRoot, join(vaultRoot, ...entry.originalPath.split('/')));
        await suppressWatcher(vaultRoot, entry.originalPath, entry.kind);
      }
      const watcher = getActiveWatcher();
      const moveDone = watcher?.beginOwnMove();
      try {
        const restored = await restoreFromTrash(vaultRoot, trashId);
        if (restored.alongside) await suppressWatcher(vaultRoot, restored.restoredPath, restored.kind);
        watcher?.noteOwnRestore(restored.restoredPath, trashId);
        return { success: true, ...restored };
      } finally {
        moveDone?.();
      }
    } catch (err) {
      if (!(err instanceof TrashItemMissingError)) logMainError('vault:trash-restore', err);
      return errorResult(err);
    }
  });

  /** Lists the trash, newest first. Read-only. */
  ipcMain.handle('vault:trash-list', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
      return { success: true, entries: await listTrash(vaultRoot), machineId: getMachineIdentity().machineId };
    } catch (err) {
      logMainError('vault:trash-list', err);
      return errorResult(err);
    }
  });

  /**
   * Sends trashed items to the OS Recycle Bin. Items the Recycle Bin refuses
   * stay in Filo's trash and come back as `TRASH_FAILED` with the list, so the
   * renderer can ask before deleting them for good. Never deletes on its own.
   */
  ipcMain.handle('vault:trash-purge', async (_event, vaultRoot: string, which: string[] | 'olderThan30d') => {
    try {
      assertActiveVault(vaultRoot);
      const result = await purgeTrash(vaultRoot, which, {
        machineId: getMachineIdentity().machineId,
        trashItem: (absPath) => shell.trashItem(absPath),
      });
      if (result.failed.length > 0) {
        return { success: false, code: 'TRASH_FAILED', purged: result.purged, failed: result.failed };
      }
      return { success: true, purged: result.purged };
    } catch (err) {
      logMainError('vault:trash-purge', err);
      return errorResult(err);
    }
  });

  /**
   * Deletes trashed items for good. The renderer calls this only after the
   * user answered "Delete permanently?" for items the Recycle Bin refused.
   */
  ipcMain.handle('vault:trash-delete-permanently', async (_event, vaultRoot: string, trashIds: string[]) => {
    try {
      assertActiveVault(vaultRoot);
      return { success: true, deleted: await deleteTrashedPermanently(vaultRoot, trashIds) };
    } catch (err) {
      logMainError('vault:trash-delete-permanently', err);
      return errorResult(err);
    }
  });
}
