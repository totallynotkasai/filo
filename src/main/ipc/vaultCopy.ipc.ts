import { ipcMain } from 'electron';
import { basename, join } from 'path';
import { promises as fsPromises } from 'fs';
import { toPosix } from '../../shared/pathUtils';
import { copyFileToVault } from '../vault/fileOps';
import {
  vaultRelativeIfInside,
  vaultRelativeWithin,
  assertSafeRelativePath,
  assertNotInFiloDir,
  assertWithinVault,
} from '../utils/pathSecurity';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { isApprovedCopySource, isChosenCopySource } from '../services/approvedSources';
import { logMainError } from '../utils/mainLogger';
import { ipcErrorCode } from './ipcErrorCode';

/**
 * `vault:copy-file` handler — copies an external (or in-vault) file into the
 * vault. The source-approval and symlink/device TOCTOU guards live here
 * together so the whole copy threat model is in one file.
 */

/**
 * Maximum size, in bytes, of a single file copied into the vault via
 * `vault:copy-file`. Caps the renderer's ability to pull in extremely large
 * external files (e.g. multi-GB media someone dropped onto a board by
 * accident) before we hit a disk-full or atomic-write failure deep inside
 * `copyFileToVault`. 100 MB leaves headroom for legitimate video imports.
 */
const VAULT_COPY_MAX_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * The folders of `.filo/` that hold the user's own files rather than Filo's
 * state: rescue copies and kept versions, and Filo's trash. A file the user
 * dragged or picked out of one of them may be copied back into the vault.
 */
const FILO_USER_FILE_DIRS = ['.filo/recovery/', '.filo/trash/'];

function inFiloUserFileDir(sourceRel: string): boolean {
  const lower = toPosix(sourceRel).toLowerCase();
  return FILO_USER_FILE_DIRS.some((dir) => lower.startsWith(dir));
}

/**
 * Registers the `vault:copy-file` IPC handler. Called from `ipc/index.ts`
 * right after `registerVaultHandlers()`.
 */
export function registerVaultCopyHandlers(): void {
  /**
   * Copies a file from an external source into the vault.
   *
   * `destFolder` is a vault-relative folder path. Pass an empty string (or
   * omit it) to drop the file at the vault root. Filename collisions are
   * resolved by suffixing `(1)`, `(2)`, … in `fileOps.copyFileToVault`.
   *
   * Returns both the absolute path and the relative path from the vault root.
   */
  ipcMain.handle(
    'vault:copy-file',
    async (
      _event,
      sourcePath: string,
      vaultPath: string,
      destFolder?: string,
    ) => {
      try {
        assertActiveVault(vaultPath);
        if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
          throw new Error('sourcePath must be a non-empty string');
        }
        // Only in-vault files or user-picked (dialog) / dropped
        // (approved-source registry) paths may be a source; else this channel is
        // an arbitrary host-file READ. Runs BEFORE any lstat/open (untouched path).
        if (!isApprovedCopySource(vaultPath, sourcePath)) {
          return {
            success: false,
            code: 'FORBIDDEN',
            error: 'Source path is not an approved import location — use the file picker or drag-and-drop',
          };
        }
        // Stat the source before the copy so we can reject oversized imports
        // up front. Without this an accidental drop of a multi-GB file would
        // run a full copy, possibly fill the disk, before any caller learned
        // it failed. It also surfaces ENOENT cleanly via ipcErrorCode.
        //
        // `lstat`, not `stat`: a symlink to a device like `/dev/zero` must be
        // rejected as "not a file". `stat` would follow it and pass the size
        // cap (size 0), then the copy would read until the disk is full.
        const sourceStat = await fsPromises.lstat(sourcePath);
        if (!sourceStat.isFile()) {
          return { success: false, code: 'IO_ERROR', error: 'Source is not a regular file' };
        }
        if (sourceStat.size > VAULT_COPY_MAX_SIZE_BYTES) {
          return {
            success: false,
            code: 'FILE_TOO_LARGE',
            error: `Source file is ${sourceStat.size} bytes; vault:copy-file cap is ${VAULT_COPY_MAX_SIZE_BYTES} bytes`,
          };
        }
        const subfolder =
          typeof destFolder === 'string' && destFolder.trim().length > 0
            ? toPosix(destFolder).replace(/^\/+/, '').replace(/\/+$/, '')
            : undefined;
        // Segment-level validation on the subfolder (a per-segment reserved
        // name would pass `assertWithinVault` but still open a device handle
        // on Windows). `forCreation: true` because this channel creates new
        // subfolders + file paths.
        if (subfolder) assertSafeRelativePath(subfolder, { forCreation: true });

        // Refuse `.filo/` on both ends:
        //  - dest: the subfolder + basename pair must not land inside `.filo/`
        //  - src: if the source happens to live INSIDE the vault under
        //    `.filo/`, refuse — generic copy must not exfiltrate config. The
        //    one exception is a file the user chose (dialog or OS drop) from
        //    the folders that hold their own files: a rescue copy, a kept
        //    version, a trashed note.
        if (subfolder) {
          const destRel = `${subfolder}/${basename(sourcePath)}`;
          assertNotInFiloDir(vaultPath, destRel);
        } else {
          assertNotInFiloDir(vaultPath, basename(sourcePath));
        }
        // Decided on the spelling containment matched, so a source named
        // through an 8.3 or junction spelling of the vault is still seen inside.
        const sourceRel = vaultRelativeIfInside(vaultPath, sourcePath);
        if (sourceRel && !(inFiloUserFileDir(sourceRel) && isChosenCopySource(sourcePath))) assertNotInFiloDir(vaultPath, sourceRel);

        // The destination is checked before anything is created or written: a
        // folder in the vault that is a junction (or a link) to somewhere else
        // would otherwise take the copy outside the vault, and the check after
        // the copy would come too late.
        assertWithinVault(vaultPath, join(subfolder ? join(vaultPath, subfolder) : vaultPath, basename(sourcePath)));

        const destPath = await copyFileToVault(sourcePath, vaultPath, subfolder, VAULT_COPY_MAX_SIZE_BYTES, true); // final `true` = noFollowSource (O_NOFOLLOW/lstat-reject; see openSourceForCopy)
        const relativePath = vaultRelativeWithin(vaultPath, destPath);
        return { success: true, path: destPath, relativePath };
      } catch (err) {
        logMainError('vault:copy-file', err);
        return { success: false, code: ipcErrorCode(err), error: String(err) };
      }
    },
  );
}
