import { NoActiveVaultError } from '../utils/activeVaultCheck';
import { PayloadTooLargeError } from '../utils/payloadLimits';
import { FiloDirForbiddenError } from '../utils/pathSecurity';
import { RenameTargetExistsError } from '../vault/fileOps';

/**
 * Maps a Node fs error to a stable, renderer-friendly error code. Renderer
 * callers shouldn't have to string-match `err.message` to distinguish
 * "file does not exist" from "I/O error" or "permission denied".
 *
 * `NO_ACTIVE_VAULT` takes precedence so handlers gated by `assertActiveVault`
 * can return a single combined code through this helper.
 *
 * Audit-14 6.1 — extracted from `vault.ipc.ts` (which sat at the 1000-LOC
 * ceiling) so both it and the split-out `vaultCopy.ipc.ts` handler can share
 * the same mapper without one importing the other's registration module.
 */
export function ipcErrorCode(err: unknown): 'NO_ACTIVE_VAULT' | 'FILE_TOO_LARGE' | 'INVALID_FILENAME' | 'FORBIDDEN' | 'TARGET_EXISTS' | 'ENOENT' | 'EACCES' | 'ENOSPC' | 'IO_ERROR' {
  if (err instanceof NoActiveVaultError) return 'NO_ACTIVE_VAULT';
  if (err instanceof PayloadTooLargeError) return 'FILE_TOO_LARGE';
  // Phase 1 / 1.2 — generic vault channels can't write to `.filo/`. The
  // FORBIDDEN code lets the renderer tell "the OS refused" from "your
  // caller asked us to do something it isn't allowed to do".
  if (err instanceof FiloDirForbiddenError) return 'FORBIDDEN';
  // Phase 1 / 1.1 — `RenameTargetExistsError` surfaces from the
  // `renameItem` pre-flight on POSIX so the renderer can prompt for
  // overwrite confirmation rather than silently losing the destination
  // file. Windows already returns EEXIST/EPERM through the generic
  // `EACCES` branch below, but the dedicated code is clearer for the
  // dominant prompt-flow case (POSIX).
  if (err instanceof RenameTargetExistsError) return 'TARGET_EXISTS';
  // Phase 31 A3.6 — surface assertSafeFilename rejections (Windows
  // reserved names, control chars, path separators) as a distinct code
  // so the renderer's rename-fail toast can mention the rule instead of
  // the generic "rename failed" copy.
  if (err instanceof Error && /^Unsafe filename rejected/.test(err.message)) {
    return 'INVALID_FILENAME';
  }
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'TARGET_EXISTS') return 'TARGET_EXISTS';
  // Windows-side rename collision: `fs.rename` surfaces EEXIST when the
  // destination exists and EPERM in some directory cases. Translate
  // EEXIST through the dedicated code so the renderer prompt-flow shape
  // matches the POSIX path. EPERM stays in EACCES below — it can also
  // come from non-overwrite causes (locked file, antivirus hold) and
  // the renderer wouldn't know to prompt.
  if (code === 'EEXIST') return 'TARGET_EXISTS';
  if (code === 'ENOENT') return 'ENOENT';
  if (code === 'EACCES' || code === 'EPERM') return 'EACCES';
  // Phase 40 / 40.3 — distinguish disk-full from generic IO_ERROR so the
  // renderer's drag-drop toast can tell the user to free space rather
  // than offering an unhelpful "try again". `copyFileToVault` and
  // `atomicWriteFile` already preserve the partially-written tmp on
  // these codes; the dedicated code lets the toast surface that path.
  if (code === 'ENOSPC' || code === 'EIO' || code === 'ENOMEM') return 'ENOSPC';
  return 'IO_ERROR';
}
