import { ipcMain } from 'electron';
import { basename } from 'path';
import { promises as fsPromises } from 'fs';
import { toPosix, relativePosix } from '../utils/pathHelpers';
import { copyFileToVault } from '../vault/fileOps';
import {
  assertWithinVault,
  assertSafeRelativePath,
  assertNotInFiloDir,
} from '../utils/pathSecurity';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { isApprovedCopySource } from '../services/approvedSources';
import { logMainError } from '../utils/mainLogger';
import { ipcErrorCode } from './ipcErrorCode';

/**
 * `vault:copy-file` handler — copies an external (or in-vault) file into the
 * vault. Audit-14 6.1 split this security-sensitive path out of `vault.ipc.ts`
 * (which had hit the 1000-LOC ceiling). It shares the `ipcErrorCode` mapper
 * with the rest of the vault handlers and is registered alongside them from
 * `ipc/index.ts`. The source-approval (Audit-12 S1) + symlink/device TOCTOU
 * (Audit-14 4.3) guards live here together so the whole copy threat model is
 * in one file.
 */

/**
 * Maximum size, in bytes, of a single file copied into the vault via
 * `vault:copy-file`. Caps the renderer's ability to pull in extremely large
 * external files (e.g. multi-GB media someone dropped onto a board by
 * accident) before we hit a disk-full or atomic-write failure deep inside
 * `copyFileToVault`. 100 MB matches the Phase 6 destructive-undo cap order
 * of magnitude (25 MB) while leaving headroom for legitimate video imports.
 */
const VAULT_COPY_MAX_SIZE_BYTES = 100 * 1024 * 1024;

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
        // Audit-12 S1 — only in-vault files or user-picked (dialog) / dropped
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
        // it failed. `fs.stat` also surfaces ENOENT cleanly via ipcErrorCode.
        //
        // Sprint A / A11 — `fs.lstat` (not `fs.stat`) so a symbolic link to
        // a character device like `/dev/zero` is rejected as "not a file"
        // up front. `stat` follows the symlink and reports `isFile()` on
        // the target; since `/dev/zero` has `size === 0`, the cap check
        // below would pass and `copyFile` would then read from /dev/zero
        // until disk is full (no EOF). `lstat` reports the SYMLINK's type,
        // which is `isSymbolicLink()` not `isFile()`, so we refuse.
        // Regular files lstat as `isFile()` so the legitimate path is
        // unchanged.
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
        // Phase 37 / 37.5 + 6.3.P1/P2 — segment-level validation on the
        // subfolder (a per-segment reserved name would pass `assertWithinVault`
        // but still open a device handle on Windows). `forCreation: true`
        // because this channel creates new subfolders + file paths.
        if (subfolder) assertSafeRelativePath(subfolder, { forCreation: true });

        // Phase 1 / 1.2 — refuse `.filo/` on both ends:
        //  - dest: the subfolder + basename pair must not land inside `.filo/`
        //  - src: if the source happens to live INSIDE the vault under
        //    `.filo/`, refuse — generic copy must not exfiltrate config.
        if (subfolder) {
          const destRel = `${subfolder}/${basename(sourcePath)}`;
          assertNotInFiloDir(destRel);
        } else {
          assertNotInFiloDir(basename(sourcePath));
        }
        const sourceRel = relativePosix(vaultPath, sourcePath);
        if (sourceRel && !sourceRel.startsWith('..') && !sourceRel.startsWith('/')) {
          assertNotInFiloDir(sourceRel);
        }

        const destPath = await copyFileToVault(sourcePath, vaultPath, subfolder, VAULT_COPY_MAX_SIZE_BYTES, true); // Audit-14 4.3 — final `true` = noFollowSource (O_NOFOLLOW/lstat-reject; see openSourceForCopy)
        assertWithinVault(vaultPath, destPath);
        const relativePath = relativePosix(vaultPath, destPath);
        return { success: true, path: destPath, relativePath };
      } catch (err) {
        logMainError('vault:copy-file', err);
        return { success: false, code: ipcErrorCode(err), error: String(err) };
      }
    },
  );
}
