import { registerVaultHandlers } from './vault.ipc';
import { registerBoardHandlers } from './board.ipc';
import { registerDialogHandlers } from './dialog.ipc';
import { registerMediaHandlers } from './media.ipc';
import { registerExportHandlers } from './export.ipc';
import { registerFontHandlers } from './fonts.ipc';
import { registerShellHandlers } from './shell.ipc';
import { registerTagsHandlers } from './tags.ipc';
import { registerTemplateHandlers } from './templates.ipc';
import { registerSidebarHandlers } from './sidebar.ipc';

/**
 * Registers all IPC handlers for the main process.
 * Call this once during app initialization.
 */
export function registerAllHandlers(): void {
  registerVaultHandlers();
  registerBoardHandlers();
  registerDialogHandlers();
  registerMediaHandlers();
  registerExportHandlers();
  registerFontHandlers();
  registerShellHandlers();
  registerTagsHandlers();
  registerTemplateHandlers();
  registerSidebarHandlers();
}
