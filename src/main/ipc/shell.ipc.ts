import { ipcMain, shell } from 'electron';
import { assertWithinVault } from '../utils/pathSecurity';
import { getVaultRoot } from './vault.ipc';
import { logMainError } from '../utils/mainLogger';

/**
 * Shell / OS integration IPC handlers.
 *
 * `shell:show-item-in-folder` is bound to the active vault. The renderer
 * can ask Explorer / Finder to reveal a file but only if that file lives
 * under the open vault root — a buggy or compromised renderer cannot use
 * this handler to reveal arbitrary host paths (`C:\Windows\System32`,
 * `~/.ssh`, etc.) just by asking.
 *
 * External URL opening goes through `media:open-external`.
 */
export function registerShellHandlers(): void {
  ipcMain.handle('shell:show-item-in-folder', (_event, fullPath: string) => {
    if (typeof fullPath !== 'string' || fullPath.length === 0) return false;
    const vaultRoot = getVaultRoot();
    if (!vaultRoot) return false;
    try {
      assertWithinVault(vaultRoot, fullPath);
    } catch (err) {
      logMainError('shell:show-item-in-folder', err);
      return false;
    }
    shell.showItemInFolder(fullPath);
    return true;
  });
}
