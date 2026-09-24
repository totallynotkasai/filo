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
 */
export function ipcErrorCode(err: unknown): 'NO_ACTIVE_VAULT' | 'FILE_TOO_LARGE' | 'INVALID_FILENAME' | 'FORBIDDEN' | 'TARGET_EXISTS' | 'ENOENT' | 'EACCES' | 'ENOSPC' | 'IO_ERROR' {
  if (err instanceof NoActiveVaultError) return 'NO_ACTIVE_VAULT';
  if (err instanceof PayloadTooLargeError) return 'FILE_TOO_LARGE';
  // Generic vault channels can't write to `.filo/`. FORBIDDEN lets the
  // renderer tell "the OS refused" from "the caller asked for something it
  // isn't allowed to do".
  if (err instanceof FiloDirForbiddenError) return 'FORBIDDEN';
  // From the `renameItem` pre-flight on POSIX, so the renderer can prompt
  // for overwrite confirmation rather than silently losing the destination.
  if (err instanceof RenameTargetExistsError) return 'TARGET_EXISTS';
  // Surface assertSafeFilename rejections (Windows
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
  // Distinguish disk-full from generic IO_ERROR so the
  // renderer's drag-drop toast can tell the user to free space rather
  // than offering an unhelpful "try again". `copyFileToVault` and
  // `atomicWriteFile` already preserve the partially-written tmp on
  // these codes; the dedicated code lets the toast surface that path.
  if (code === 'ENOSPC' || code === 'EIO' || code === 'ENOMEM') return 'ENOSPC';
  return 'IO_ERROR';
}
