import { ipcMain } from 'electron';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { assertSafeRelativePath, assertNotInFiloDir } from '../utils/pathSecurity';
import { logMainError } from '../utils/mainLogger';
import { keepUnsavedCopies } from '../services/recoverySnapshot';
import { preservedEmergencyFilesIn } from '../services/quitFailureBreadcrumb';

/**
 * Rescue copies for close and quit: when the user leaves a vault with work
 * that couldn't be saved, the renderer hands over the text it holds and this
 * keeps it in `.filo/recovery/`, so "Close anyway" / "Quit anyway" never drops
 * it outright.
 */
export function registerRecoveryHandlers(): void {
  /**
   * Writes each item's text to `.filo/recovery/<timestamp>-unsaved/`. Each
   * `relPath` is only the copy's name (flattened), but it must still be a safe
   * vault path outside `.filo/`, so a bad name can't steer the write.
   */
  ipcMain.handle(
    'recovery:keep-unsaved',
    async (_event, vaultRoot: string, items: Array<{ relPath: string; text: string }>) => {
      try {
        assertActiveVault(vaultRoot);
        for (const item of items) {
          assertSafeRelativePath(item.relPath);
          assertNotInFiloDir(item.relPath);
        }
        const kept = await keepUnsavedCopies(vaultRoot, items);
        return { ok: true, ...kept };
      } catch (err) {
        logMainError('recovery:keep-unsaved', err);
        const code = (err as NodeJS.ErrnoException | null)?.code;
        return { ok: false, ...(typeof code === 'string' ? { code } : {}), error: String(err) };
      }
    },
  );

  /**
   * How many partial `.tmp` files a failed write preserved in this vault this
   * session, so the quit dialog mentions them only when there are some.
   */
  ipcMain.handle('recovery:preserved-tmp', async (_event, vaultRoot: string) => {
    try {
      assertActiveVault(vaultRoot);
      return { ok: true, count: preservedEmergencyFilesIn(vaultRoot).length };
    } catch (err) {
      logMainError('recovery:preserved-tmp', err);
      return { ok: false, error: String(err) };
    }
  });
}
