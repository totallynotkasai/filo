import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { isUtf8 } from 'buffer';
import { join } from 'path';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { assertNotInFiloDir, assertSafeRelativePath, assertWithinVault } from '../utils/pathSecurity';
import { logMainError } from '../utils/mainLogger';
import { atomicWriteFile, LOCK_AWARE_SUPPRESS_MS } from '../vault/filenameUtils';
import { snapshotForRecovery } from '../services/recoverySnapshot';
import { clearNonUtf8 } from '../services/nonUtf8Registry';
import { getActiveWatcher, noteOwnWrite } from './vault.ipc';
import { ipcErrorCode } from './ipcErrorCode';

/**
 * The ONLY way Filo rewrites a non-UTF-8 note.
 *
 * DECISION: explicit and lossy-aware. The original bytes are snapshotted to
 * `.filo/recovery/` FIRST, then decoded as Windows-1252 (the common legacy
 * Windows encoding; no auto-detection of other code pages) and written back as
 * UTF-8. A UTF-16 file (BOM `FF FE` / `FE FF`) is refused — decoding it as 1252
 * would produce garbage. An already-valid file is left untouched.
 */
export function registerVaultEncodingHandlers(): void {
  ipcMain.handle('vault:convert-to-utf8', async (_event, vaultRoot: string, relativePath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relativePath);
      assertNotInFiloDir(relativePath);
      const fullPath = join(vaultRoot, relativePath);
      assertWithinVault(vaultRoot, fullPath);
      const bytes = await fs.readFile(fullPath);
      if (isUtf8(bytes)) {
        clearNonUtf8(fullPath);
        return { success: true, converted: false };
      }
      const utf16 =
        bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
      if (utf16) {
        return { success: false, code: 'UTF16', error: 'UTF-16 files cannot be converted as Windows-1252' };
      }
      const backup = await snapshotForRecovery(vaultRoot, relativePath);
      const text = new TextDecoder('windows-1252').decode(bytes);
      getActiveWatcher()?.suppressWrite(relativePath, LOCK_AWARE_SUPPRESS_MS, text);
      await atomicWriteFile(fullPath, text);
      noteOwnWrite(relativePath, text);
      clearNonUtf8(fullPath);
      return { success: true, converted: true, backupPath: backup };
    } catch (err) {
      logMainError('vault:convert-to-utf8', err);
      return { success: false, code: ipcErrorCode(err), error: String(err) };
    }
  });
}
