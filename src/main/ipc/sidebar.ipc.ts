import { ipcMain } from 'electron';
import { loadSidebarState, updateSidebarState, SidebarPatchSchema } from '../services/sidebarState';

/**
 * Sidebar IPC handlers — per-machine state for the vault sidebar:
 * shown or hidden, width, in-app floating-mode flag, and last floating-panel bounds.
 *
 * The vault sidebar lives entirely inside the main window. When the
 * user toggles "Float", the renderer renders the sidebar as a draggable
 * panel via `FloatingVaultPanel.svelte` and persists its geometry through
 * `sidebar:set-state`. No separate BrowserWindow is involved.
 */

export function registerSidebarHandlers(): void {
  ipcMain.handle('sidebar:get-state', async () => {
    return loadSidebarState();
  });

  ipcMain.handle('sidebar:set-state', async (_event, patch: unknown) => {
    const parsed = SidebarPatchSchema.safeParse(patch);
    if (!parsed.success) return loadSidebarState();
    return updateSidebarState(parsed.data);
  });
}
