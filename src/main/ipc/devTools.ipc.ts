import { ipcMain } from 'electron';
import { devToolsEnabled, setDevToolsPreference } from '../services/devTools';
import { logMainError } from '../utils/mainLogger';
import { errorResult } from './ipcErrorCode';

/**
 * General → Developer tools: the per-machine switch and its "Open developer
 * tools" button. Main keeps the switch, so the page can't open the tools
 * while it is off.
 */
export function registerDevToolsHandlers(): void {
  ipcMain.handle('app:get-dev-tools', () => ({ enabled: devToolsEnabled() }));

  ipcMain.handle('app:set-dev-tools', async (event, enabled: unknown) => {
    try {
      await setDevToolsPreference(enabled === true, event.sender);
      return { success: true };
    } catch (err) {
      logMainError('app:set-dev-tools', err);
      return errorResult(err);
    }
  });

  ipcMain.handle('app:open-dev-tools', (event) => {
    if (!devToolsEnabled()) return { success: false, code: 'FORBIDDEN', error: 'Developer tools are turned off in Settings.' };
    event.sender.openDevTools({ mode: 'detach' });
    return { success: true };
  });
}
