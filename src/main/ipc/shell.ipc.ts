import { ClipboardItem, clipboard, ipcMain, shell } from 'electron';
import { assertWithinVault } from '../utils/pathSecurity';
import { getVaultRoot } from './vault.ipc';
import { logMainError } from '../utils/mainLogger';
import { isKeptRescuePath } from '../services/recoverySnapshot';
import { clipboardPayload } from '../utils/clipboardPayload';

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
 *
 * `shell:copy-text` writes the clipboard for the renderer, which may not
 * (`utils/clipboardPayload.ts`): plain text, or a `filo://` link with the
 * name it reads as.
 */
export function registerShellHandlers(): void {
  ipcMain.handle('shell:show-item-in-folder', (_event, fullPath: string) => {
    if (typeof fullPath !== 'string' || fullPath.length === 0) return false;
    // The open vault, or a rescue folder written this session (its vault
    // may have closed since: the notice naming it outlives the swap).
    if (!isKeptRescuePath(fullPath)) {
      const vaultRoot = getVaultRoot();
      if (!vaultRoot) return false;
      try {
        assertWithinVault(vaultRoot, fullPath);
      } catch (err) {
        logMainError('shell:show-item-in-folder', err);
        return false;
      }
    }
    shell.showItemInFolder(fullPath);
    return true;
  });

  ipcMain.handle('shell:copy-text', async (_event, text: unknown, linkLabel?: unknown) => {
    const payload = clipboardPayload(text, linkLabel);
    if (!payload) return false;
    try {
      if (payload.html !== undefined) {
        await clipboard.write([new ClipboardItem({ 'text/plain': payload.text, 'text/html': payload.html })]);
      } else {
        await clipboard.writeText(payload.text);
      }
      return true;
    } catch (err) {
      logMainError('shell:copy-text', err);
      return false;
    }
  });
}
