import { NoActiveVaultError } from '../utils/activeVaultCheck';
import { PayloadTooLargeError } from '../utils/payloadLimits';
import { FiloDirForbiddenError } from '../utils/pathSecurity';
import { RenameTargetExistsError } from '../vault/fileOps';
import { BoardFolderMissingError } from '../vault/boardFileOps';
import { LinkedFileError, StaleWriteError } from '../vault/filenameUtils';

/**
 * Maps a Node fs error to a stable, renderer-friendly error code. Renderer
 * callers shouldn't have to string-match `err.message` to distinguish
 * "file does not exist" from "I/O error" or "permission denied".
 *
 * `NO_ACTIVE_VAULT` takes precedence so handlers gated by `assertActiveVault`
 * can return a single combined code through this helper.
 */
export function ipcErrorCode(err: unknown): 'NO_ACTIVE_VAULT' | 'FILE_TOO_LARGE' | 'INVALID_FILENAME' | 'FORBIDDEN' | 'TARGET_EXISTS' | 'ENOENT' | 'EACCES' | 'ENOSPC' | 'STALE' | 'NOTE_IS_LINK' | 'IO_ERROR' {
  if (err instanceof NoActiveVaultError) return 'NO_ACTIVE_VAULT';
  if (err instanceof PayloadTooLargeError) return 'FILE_TOO_LARGE';
  // Generic vault channels can't write to `.filo/`. FORBIDDEN lets the
  // renderer tell "the OS refused" from "the caller asked for something it
  // isn't allowed to do".
  if (err instanceof FiloDirForbiddenError) return 'FORBIDDEN';
  // From the `renameItem` pre-flight on POSIX, so the renderer can prompt
  // for overwrite confirmation rather than silently losing the destination.
  if (err instanceof RenameTargetExistsError) return 'TARGET_EXISTS';
  // A note write whose file changed since the renderer read it: the renderer
  // reads again and re-applies its change rather than overwrite that version.
  if (err instanceof StaleWriteError) return 'STALE';
  // A note write onto a symbolic link: replacing it would detach the note
  // from the original, so the write is refused and the renderer says why.
  if (err instanceof LinkedFileError) return 'NOTE_IS_LINK';
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

/**
 * The code a write handler's failure carries. The fs errno is kept as-is
 * (EBUSY, EPERM…) rather than folded, because the renderer's write
 * schedulers decide from it whether a failed write is kept and re-fired by
 * Retry; a failure with no code would leave the path failed with nothing to
 * retry. Filo's own typed errors map as in `ipcErrorCode`.
 */
export function failureCode(err: unknown): string {
  const errno = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === 'string' && /^E[A-Z]+$/.test(errno)) return errno;
  // A board save whose folder is gone: kept for a retry, never recreated.
  if (err instanceof BoardFolderMissingError) return err.code;
  return ipcErrorCode(err);
}

/** The `{ ok: false }` failure every write handler returns: always with a code. */
export function errorEnvelope(err: unknown): { ok: false; code: string; error: string } {
  return { ok: false, code: failureCode(err), error: String(err) };
}

/** `errorEnvelope` for the channels whose envelope says `success` rather than `ok`. */
export function errorResult(err: unknown): { success: false; code: string; error: string } {
  return { success: false, code: failureCode(err), error: String(err) };
}
