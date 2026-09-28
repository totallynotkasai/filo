/**
 * writeErrorToast — builds the user-facing toast for a failed debounced write.
 *
 * Pure + side-effect-free so it can be unit-tested without mounting App.svelte.
 * The App.svelte write-error listener calls `buildWriteErrorToast(info)` and
 * feeds the result through the shared coalescing aggregator (so a multi-target
 * failure shows ONE count-badged toast per write kind instead of one per file).
 *
 * When an atomic write fails AFTER fully writing + fsyncing its tmp file
 * (ENOSPC / EIO / ENOMEM / EACCES on the final rename), main's
 * `atomicWriteFile` PRESERVES the tmp and annotates the error with its path
 * (`filenameUtils.ts`). The bytes ARE on disk, so the toast must not say "not
 * on disk yet"; `extractPreservedTmpPath` recovers the path so the toast can
 * point the user at it.
 */

import type { WriteErrorInfo } from './writeStateTracking';

/**
 * Recovers the preserved emergency-tmp path from a write error, if present.
 *
 * The path rides to the renderer only inside the error MESSAGE string: the IPC
 * envelope carries `error: String(err)` + `code`, not the main-side custom
 * `preservedTmpPath` property (which does not survive IPC marshalling). So we
 * parse the `(data preserved at <tmpPath>)` annotation `atomicWriteFile`
 * appends — but ALSO honour an explicit `preservedTmpPath` property first, in
 * case a future envelope plumbs one through (or a test supplies it directly).
 */
export function extractPreservedTmpPath(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const prop = (error as { preservedTmpPath?: unknown }).preservedTmpPath;
    if (typeof prop === 'string' && prop) return prop;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      const fromMessage = matchPreservedPath(message);
      if (fromMessage) return fromMessage;
    }
  }
  if (typeof error === 'string') return matchPreservedPath(error);
  return undefined;
}

/**
 * Matches the `(data preserved at <tmpPath>)` annotation that
 * `atomicWriteFile` appends at the END of the error message. `<tmpPath>` is
 * `<filePath>.<nonce>.tmp`, so the run ends in `.tmp)`. Greedy on the leading
 * capture so an `.tmp` embedded earlier in the destination path can't truncate
 * a longer real tmp path — it backtracks to the final `.tmp)`.
 */
function matchPreservedPath(text: string): string | undefined {
  const m = /data preserved at (.+\.tmp)\)/.exec(text);
  return m ? m[1] : undefined;
}

/**
 * Reads the `code` string off an error-like value (the `{ code }` annotation
 * schedulers attach via `Object.assign(new Error(...), { code })`), used to
 * branch the toast copy (e.g. `CONFIG_CORRUPT`).
 */
function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export interface WriteErrorToastSpec {
  /**
   * Display prefix for the aggregator. One per write kind so all board
   * failures collapse into one toast, all settings into another, all file
   * (component) writes into a third.
   */
  context: string;
  /** Detail line the aggregator renders after the context prefix. */
  message: string;
  /**
   * Distinct coalescing key when this write PRESERVED bytes at a tmp
   * path: `"<context>::<preservedPath>"`. Two same-kind failures that preserved
   * to DIFFERENT locations then keep separate toasts so neither recovery path
   * is hidden (the shared toast would otherwise overwrite #1's path with #2's).
   * Undefined for the common no-preserve case, so those still coalesce by kind.
   */
  coalesceKey?: string;
  /**
   * The failure is transient-shaped and the scheduler retained
   * the write, so the toast offers Retry (re-fires every retained failed write).
   * False for a deliberate skip (CONFIG_CORRUPT) that retrying can't fix.
   */
  retryable: boolean;
}

/**
 * Maps a `WriteErrorInfo` to the `{ context, message, coalesceKey }` the
 * aggregator renders as `"<context>: <message>"` (or `"<context> (N×):
 * <message>"` when coalesced under the same key).
 */
export function buildWriteErrorToast(info: WriteErrorInfo): WriteErrorToastSpec {
  const where = info.path ? ` (${info.path})` : '';
  // Main refused to overwrite a note whose bytes aren't UTF-8
  // (the write would have replaced every accented character with U+FFFD).
  if (errorCode(info.error) === 'NOT_UTF8') {
    return {
      context: 'Note not saved',
      message:
        `Filo didn't save${where} because the file isn't UTF-8 text — saving would damage its accented characters. ` +
        'Open the note and use "Convert to UTF-8…" (the original is backed up first).',
      coalesceKey: `not-utf8::${info.path ?? ''}`,
      retryable: false,
    };
  }
  // Main refused to write over a symbolic link (the write would replace the
  // link with a regular file, cutting the note off from the original).
  if (errorCode(info.error) === 'NOTE_IS_LINK') {
    return {
      context: 'Note not saved',
      message: `Filo didn't save${where} because this note is a link to another file. Edit the original.`,
      coalesceKey: `note-is-link::${info.path ?? ''}`,
      retryable: false,
    };
  }
  // A corrupt-config suppression is NOT a disk-space / permission
  // failure, so it gets its own honest copy instead of the generic message
  // below. The config write is being SKIPPED on purpose to preserve the
  // unparseable file on disk; tell the user their in-memory changes won't
  // persist and how to resolve it. Coalesces per target so a burst of edits to
  // the same corrupt file shows one count-badged toast, not one per keystroke.
  if (errorCode(info.error) === 'CONFIG_CORRUPT') {
    return {
      context: 'Settings not saving',
      message:
        `Filo isn't saving changes${where} — its on-disk copy is unreadable, so it's left untouched to avoid clobbering it. ` +
        'Your edits stay in memory but aren\'t saved. Fix or replace the file, and Filo saves again once it reads.',
      coalesceKey: `config-corrupt::${info.path ?? ''}`,
      retryable: false,
    };
  }
  // Another program changed the file, and Filo held its change back rather
  // than write over theirs. Nothing is wrong with the disk, and Retry can't
  // help: the user's choice on the prompt (or their next change) decides.
  if (errorCode(info.error) === 'EXTERNAL_EDIT') {
    const shown = info.path === 'config:save-workspace' ? '.filo/workspace.json'
      : info.kind === 'config' && info.path && !info.path.includes('/') ? `.filo/${info.path}`
        : (info.path ?? 'The file');
    return info.kind === 'board'
      ? {
          context: 'Board not saved',
          message: `${shown} was changed outside Filo, so Filo didn't save over it. Your changes are kept in Filo until you choose Reload or Keep local.`,
          coalesceKey: `external-edit::${info.path ?? ''}`,
          retryable: false,
        }
      : {
          context: 'Settings not saved',
          message: `${shown} was changed outside Filo, so your change wasn't saved over it. Change the setting again to choose which version to keep.`,
          coalesceKey: `external-edit::${info.path ?? ''}`,
          retryable: false,
        };
  }
  const context =
    info.kind === 'board'
      ? 'Board save failed'
      : info.kind === 'config'
        ? 'Settings save failed'
        : 'File save failed';
  const preserved = extractPreservedTmpPath(info.error);
  const message = preserved
    ? `Filo couldn't finish writing${where}, but your unsaved bytes were preserved on disk — recover or delete them, then free up space or fix permissions:\n${preserved}`
    : `Filo couldn't save${where}. Your changes are not on disk yet — check disk space or file permissions.`;
  // Give each distinct preserved location its own coalescing key so a
  // burst of preserve-failures doesn't collapse to a single toast that names
  // only the last recovery path.
  const coalesceKey = preserved ? `${context}::${preserved}` : undefined;
  return { context, message, coalesceKey, retryable: true };
}
