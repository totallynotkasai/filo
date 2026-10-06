import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { isUtf8 } from 'buffer';
import { join } from 'path';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { assertNotInFiloDir, assertSafeRelativePath, assertWithinVault } from '../utils/pathSecurity';
import { logMainError } from '../utils/mainLogger';
import { atomicWriteFile, isSymbolicLink, LOCK_AWARE_SUPPRESS_MS, withOnDiskSpelling } from '../vault/filenameUtils';
import { snapshotForRecovery } from '../services/recoverySnapshot';
import { clearNonUtf8 } from '../services/nonUtf8Registry';
import { fnv1a32 } from '../services/fileWatcherHash';
import { getActiveWatcher, noteOwnWrite } from './vault.ipc';
import { errorResult } from './ipcErrorCode';

/**
 * The ONLY way Filo rewrites a non-UTF-8 note.
 *
 * DECISION: explicit and lossy-aware. The original bytes are snapshotted to
 * `.filo/recovery/` FIRST, then decoded as Windows-1252 (the common legacy
 * Windows encoding; no auto-detection of other code pages) and written back as
 * UTF-8. A UTF-16 file (BOM `FF FE` / `FE FF`) is refused — decoding it as 1252
 * would produce garbage. An already-valid file is left untouched.
 *
 * It overwrites as every note write does: the backup is the exact bytes it
 * converted, and the write names the stat and content hash of that read (a
 * file changed since fails with `STALE`, nothing written), refuses a symbolic
 * link, and keeps another program's case-only rename.
 */
export function registerVaultEncodingHandlers(): void {
  ipcMain.handle('vault:convert-to-utf8', async (_event, vaultRoot: string, relativePath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relativePath);
      assertNotInFiloDir(vaultRoot, relativePath);
      const fullPath = join(vaultRoot, relativePath);
      assertWithinVault(vaultRoot, fullPath);
      if (await isSymbolicLink(fullPath)) {
        return { success: false, code: 'NOTE_IS_LINK', error: `"${relativePath}" is a link to another file; convert the original` };
      }
      const before = await fs.stat(fullPath);
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
      // A read that overlapped another program's write has no stat to name.
      if (bytes.length !== before.size) {
        return { success: false, code: 'STALE', error: `"${relativePath}" changed while it was read; try again` };
      }
      const backup = await snapshotForRecovery(vaultRoot, relativePath, 'keep', bytes);
      const text = new TextDecoder('windows-1252').decode(bytes);
      getActiveWatcher()?.suppressWrite(relativePath, LOCK_AWARE_SUPPRESS_MS, text);
      await atomicWriteFile(await withOnDiskSpelling(fullPath), text, {
        expectExisting: true,
        expectStat: { mtimeMs: before.mtimeMs, size: before.size, hash: fnv1a32(bytes).toString(16).padStart(8, '0') },
        refuseLink: true,
      });
      noteOwnWrite(relativePath, text);
      clearNonUtf8(fullPath);
      return { success: true, converted: true, backupPath: backup };
    } catch (err) {
      logMainError('vault:convert-to-utf8', err);
      return errorResult(err);
    }
  });
}
