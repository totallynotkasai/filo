import { registerVaultHandlers } from './vault.ipc';
import { registerVaultCopyHandlers } from './vaultCopy.ipc';
import { registerVaultTrashHandlers } from './vaultTrash.ipc';
import { registerBoardHandlers } from './board.ipc';
import { registerDialogHandlers } from './dialog.ipc';
import { registerMediaHandlers } from './media.ipc';
import { registerFontHandlers } from './fonts.ipc';
import { registerShellHandlers } from './shell.ipc';
import { registerTagsHandlers } from './tags.ipc';
import { registerTemplateHandlers } from './templates.ipc';
import { registerSidebarHandlers } from './sidebar.ipc';
import { registerMachineHandlers } from './machine.ipc';
import { registerVaultEncodingHandlers } from './vaultEncoding.ipc';
import { registerRecoveryHandlers } from './recovery.ipc';

/**
 * Registers all IPC handlers for the main process.
 * Call this once during app initialization.
 */
export function registerAllHandlers(): void {
  registerVaultHandlers();
  registerVaultCopyHandlers();
  registerVaultTrashHandlers();
  registerBoardHandlers();
  registerDialogHandlers();
  registerMediaHandlers();
  registerFontHandlers();
  registerShellHandlers();
  registerTagsHandlers();
  registerTemplateHandlers();
  registerSidebarHandlers();
  registerMachineHandlers();
  registerVaultEncodingHandlers();
  registerRecoveryHandlers();
}
