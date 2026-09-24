import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';
import { RESERVED_WINDOWS_NAMES } from '../utils/pathSecurity';
import {
  recordPreservedEmergencyFile,
  clearPreservedEmergencyFilesForTarget,
} from '../services/emergencyFileRegistry';

/**
 * Characters that are illegal in Windows filenames.
 */
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Max filename length (without extension). Conservative for cross-platform safety.
 */
const MAX_NAME_LENGTH = 200;

/** A path component may hold at most 255 UTF-16 units (NTFS) or 255 bytes (ext4/APFS). */
const MAX_COMPONENT = 255;

/**
 * The sibling temp path `<dir>/<base>.<nonce>.tmp` for an atomic write to
 * `finalPath`. The suffix adds `nonce.length + 5` characters, so a long but
 * legal base name (≥ ~239 chars) would push the tmp component past the
 * filesystem limit and the write would fail with ENAMETOOLONG. The base is
 * truncated (whole code points only, never half a surrogate pair) until the
 * component fits in both UTF-16 units and UTF-8 bytes. The suffix is never
 * shortened: the tree, the watcher and the orphan sweep recognise tmps by it.
 */
export function tmpSiblingPath(finalPath: string, nonce: string): string {
  const cut = Math.max(finalPath.lastIndexOf('/'), finalPath.lastIndexOf('\\')) + 1;
  const dir = finalPath.slice(0, cut);
  const suffix = `.${nonce}.tmp`;
  const fits = (base: string): boolean =>
    base.length + suffix.length <= MAX_COMPONENT &&
    Buffer.byteLength(base + suffix, 'utf8') <= MAX_COMPONENT;
  let base = finalPath.slice(cut);
  if (!fits(base)) {
    const points = Array.from(base);
    while (points.length > 0 && !fits(points.join(''))) points.pop();
    base = points.join('');
  }
  return `${dir}${base}${suffix}`;
}

/**
 * Sanitizes a string for use as a filename.
 * Strips illegal characters, collapses whitespace, truncates to max length,
 * strips trailing dots / spaces (Win32 silently strips them at
 * file-create time, which collides with a same-stem neighbour), and prefixes
 * an underscore in front of any name whose stem matches a Windows DOS device
 * name (CON / NUL / COM1 / LPT1 / …) so the sanitised result can pass
 * `assertSafeFilename` instead of throwing downstream.
 */
export function sanitizeFilename(name: string): string {
  let sanitized = name
    .replace(ILLEGAL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Strip any trailing dots (or dot+space runs) BEFORE the
    // length truncation. `note.` on Win32 saves as `note`, masking a name
    // collision with a sibling `note`.
    .replace(/[. ]+$/, '');

  if (sanitized.length > MAX_NAME_LENGTH) {
    sanitized = sanitized
      .slice(0, MAX_NAME_LENGTH)
      .trim()
      .replace(/[. ]+$/, '');
  }

  // Fallback for empty names
  if (!sanitized) {
    sanitized = 'Untitled';
  }

  // Same stem-based match as `assertSafeFilename`: `CON.md` /
  // `aux.tar.gz` / `nul` all collide. Prefix with `_` so the sanitised
  // result clears the assert instead of throwing.
  const stem = (sanitized.split('.')[0] ?? '').toUpperCase();
  if (RESERVED_WINDOWS_NAMES.has(stem)) {
    sanitized = `_${sanitized}`;
  }

  return sanitized;
}

/**
 * Generates a unique filename in the target directory by appending (2), (3), etc.
 * Returns the full path to the unique file.
 */
export async function uniqueFilePath(
  dir: string,
  name: string,
  extension: string,
): Promise<string> {
  const sanitized = sanitizeFilename(name);
  let candidate = join(dir, `${sanitized}${extension}`);

  if (!(await pathExists(candidate))) {
    return candidate;
  }

  let counter = 2;
  while (true) {
    candidate = join(dir, `${sanitized} (${counter})${extension}`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
    counter++;
  }
}

/**
 * Generates a unique folder path in `dir` by appending (2), (3), etc. when
 * the base name is already taken. Mirrors `uniqueFilePath` minus the
 * extension — used by the vault sidebar's "+ New Folder" flow so the
 * default rename input pre-fills with the next free name instead of
 * silently no-op'ing on `fs.mkdir({ recursive: true })`.
 */
export async function uniqueFolderPath(
  dir: string,
  name: string,
): Promise<string> {
  const sanitized = sanitizeFilename(name);
  let candidate = join(dir, sanitized);

  if (!(await pathExists(candidate))) {
    return candidate;
  }

  let counter = 2;
  while (true) {
    candidate = join(dir, `${sanitized} (${counter})`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
    counter++;
  }
}

/**
 * Checks whether a path exists on disk.
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic, crash-safe write.
 *
 * Pipeline: `open` → `write` → `fsync(fd)` → `close` → `rename` → `fsync(dirfd)`.
 *
 * Why the explicit fsync: `fs.writeFile` returns once the data is in the
 * kernel write-back cache; a power loss before the OS flushes that cache
 * leaves a file whose `rename` "succeeded" but whose contents are zero-
 * length or torn. fsyncing the file handle before close forces the data
 * onto stable storage; fsyncing the directory after rename forces the
 * rename-metadata entry to survive too. Both are needed for a true
 * crash-safe atomic write.
 *
 * **Windows note.** `fs.fsync` on a directory handle is unsupported on
 * Windows (and silently a no-op on some platforms) — we open the dir for
 * sync best-effort and swallow EISDIR / EBADF / ENOTSUP. The file-handle
 * sync still does the load-bearing work; the dir-sync upgrade only
 * matters on Linux/macOS where rename-durability needs the explicit
 * fsync of the parent.
 *
 * Performance: fsync adds 5–50ms per call on a typical SSD (much more on
 * spinning disks). Filo writes ~30-60 board/markdown bytes per second
 * during heavy editing — well below the threshold where users notice.
 * If a measurement shows >100ms per write on real hardware, revisit by
 * batching boards into a single fsync (one per debounce window).
 *
 * Retry loop on Windows: `fs.rename` onto an existing destination is
 * racy — antivirus, the recursive `fs.watch` handle, or a concurrent
 * atomic-write may own a transient lock and return EPERM/EBUSY. Retries
 * recover from those short-lived locks without forcing callers to
 * serialise themselves around every save. The backoff is TIME-bounded
 * (`retryOnWindowsLock`, ~5 s on win32) because sync clients hold such locks
 * for seconds, not milliseconds.
 *
 * Nonce-suffixed tmp filename: two concurrent atomic writes to the same
 * destination (the body and frontmatter schedulers can both target the
 * same `.md` if their debounces fire on the same tick) would otherwise
 * race on a shared `<path>.tmp`. With per-call nonces each write owns
 * its own tmp file, so the cleanup `unlink` on failure can't accidentally
 * delete the other call's buffer mid-rename.
 *
 * `opts.expectExisting` narrows a file-resurrection race: `fs.rename(tmp,
 * dest)` creates `dest` unconditionally, so a delete landing in the
 * tmp-write→rename gap would resurrect the file. With it set, the
 * destination is re-verified immediately before each rename attempt and the
 * write aborts with ENOENT if it's gone, leaving only the microsecond
 * check→rename gap.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string | Buffer,
  opts?: { expectExisting?: boolean },
): Promise<void> {
  const nonce = randomBytes(6).toString('hex');
  const tmpPath = tmpSiblingPath(filePath, nonce);

  // Write + fsync the temp file. Keeps the data on disk before rename,
  // so a power loss between rename and dir-fsync still produces an
  // intact file (possibly under the old or new name, never empty).
  // The Buffer overload lets binary writers share the same pipeline.
  //
  // Clean up the tmp file when the write or sync itself throws (disk full
  // mid-write, antivirus quarantine), or it would linger per failed save.
  try {
    const fh = await fs.open(tmpPath, 'w');
    let writeOrSyncErr: unknown = null;
    try {
      if (typeof content === 'string') {
        await fh.writeFile(content, 'utf-8');
      } else {
        await fh.writeFile(content);
      }
      await fh.sync();
    } catch (err) {
      writeOrSyncErr = err;
    } finally {
      // Wrap close in an inner try so a close-after-throw doesn't mask
      // the original write/sync error. If write/sync already threw, we
      // re-throw it from the outer catch; the close failure is logged
      // but not raised (the tmp is about to be unlinked anyway, and the
      // original is the actionable diagnostic).
      try {
        await fh.close();
      } catch (closeErr) {
        if (writeOrSyncErr) {
          console.warn(
            '[atomicWriteFile] close() failed after a prior write/sync error; surfacing the original error:',
            closeErr,
          );
        } else {
          // Close itself is the only failure — surface it normally.
          throw closeErr;
        }
      }
    }
    if (writeOrSyncErr) throw writeOrSyncErr;
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  // Time-bounded lock backoff (~5 s on win32): OneDrive / Dropbox / antivirus
  // routinely hold a rename-blocking handle for a second or two, and an
  // exhausted retry surfaces "Save failed" plus a stray `.tmp`.
  let lastErr: unknown;
  let renamed = false;
  try {
    await retryOnWindowsLock(() => fs.rename(tmpPath, filePath), {
      // With `expectExisting`, re-verify right before EVERY rename attempt so
      // a delete since the handler's pre-check (or during the backoff) isn't
      // resurrected with stale editor bytes.
      beforeAttempt: async () => {
        if (opts?.expectExisting && !(await pathExists(filePath))) {
          const gone: NodeJS.ErrnoException = new Error(
            `atomicWriteFile: "${filePath}" no longer exists; refusing to recreate it`,
          );
          gone.code = 'ENOENT';
          throw gone;
        }
      },
    });
    renamed = true;
  } catch (err) {
    lastErr = err;
  }

  if (!renamed) {
    // The rename failed *after* the tmp was fully written and fsynced, so
    // the user's data is intact under `tmpPath` — on a quit-time flush it
    // may be their last bytes. For disk-full / hardware / OOM and for an
    // exhausted lock (EACCES / EPERM / EBUSY — a lock the user can wait
    // out), preserve the tmp and annotate the error with its path so the
    // toast can say where to look. Only other codes (e.g. ENOENT: the
    // destination is gone) fall to the best-effort cleanup.
    const code = (lastErr as NodeJS.ErrnoException | null)?.code;
    if (
      code === 'ENOSPC' ||
      code === 'EIO' ||
      code === 'ENOMEM' ||
      code === 'EACCES' ||
      code === 'EPERM' ||
      code === 'EBUSY'
    ) {
      if (lastErr && typeof lastErr === 'object') {
        (lastErr as { preservedTmpPath?: string }).preservedTmpPath = tmpPath;
        const original = (lastErr as { message?: unknown }).message;
        if (typeof original === 'string') {
          (lastErr as { message: string }).message = `${original} (data preserved at ${tmpPath})`;
        }
        // Record the preserved partial so the quit
        // drain can persist its location into `.filo/quit-failure.json`
        // for next-launch recovery (the transient toast can be missed,
        // especially when the failure lands during a quit-time flush).
        recordPreservedEmergencyFile({ preservedPath: tmpPath, targetPath: filePath, code });
      }
    } else {
      await fs.unlink(tmpPath).catch(() => undefined);
    }
    throw lastErr;
  }

  // The write landed: drop any emergency-registry entries a
  // PRIOR failed write to this same destination recorded, so the quit
  // breadcrumb stops pointing the user at superseded bytes (phantom
  // "Filo preserved emergency files" notice on the next launch). The
  // preserved `.tmp` itself stays on disk — see the registry's doc.
  clearPreservedEmergencyFilesForTarget(filePath);

  // Best-effort fsync of the containing directory so the rename's metadata
  // is durably persisted on POSIX. Windows can't open a directory for
  // sync — swallow the EISDIR / EBADF / ENOTSUP / EPERM cases silently.
  //
  // Retry on EBUSY / EACCES: SMB-mounted vaults occasionally return EBUSY on
  // a dir-handle open while antivirus or the watcher briefly holds a lock.
  // The retry adds ≤310 ms worst case. Other codes (EISDIR / EBADF / ENOTSUP
  // / EPERM) mean the platform doesn't support dir-fsync — fail open.
  const DIR_FSYNC_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
  for (let attempt = 0; attempt <= DIR_FSYNC_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const dirFh = await fs.open(dirname(filePath), 'r');
      try {
        await dirFh.sync();
      } finally {
        await dirFh.close();
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EBUSY' && code !== 'EACCES') {
        // Directory sync unsupported on this platform — file-handle sync
        // already covered the data-durability half of the crash-safety
        // contract. The trade-off is documented above.
        break;
      }
      if (attempt === DIR_FSYNC_RETRY_DELAYS_MS.length) break;
      await new Promise((resolve) => setTimeout(resolve, DIR_FSYNC_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * The error codes Windows returns while another
 * process (OneDrive, Dropbox, Explorer, antivirus) holds a handle that blocks
 * a rename / replace.
 */
export const WIN_LOCK_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Lock-retry budget. win32 only gets the long budget: on POSIX an `EACCES` is a
 * real permission error, and stalling 5 s on it would just delay the failure.
 */
export const WIN_LOCK_BUDGET_MS = process.platform === 'win32' ? 5000 : 310;

/**
 * Watcher self-write suppression to apply BEFORE an atomic write: the rename
 * can land up to `WIN_LOCK_BUDGET_MS` late, and its echo must still fall
 * inside the window.
 */
export const LOCK_AWARE_SUPPRESS_MS = WIN_LOCK_BUDGET_MS + 2000;

const LOCK_BACKOFF_MS = [10, 20, 40, 80, 160, 320, 640];
const LOCK_BACKOFF_CAP_MS = 1000;

export function lockRetryBudgetMs(): number {
  // Read at call time (not the module-load constant) so tests can emulate a
  // platform. `FILO_LOCK_RETRY_BUDGET_MS` is a diagnostic / test override (the
  // unit-test setup pins it to 310 ms so suites that force a
  // permanent lock don't each stall for 5 s).
  const override = Number(process.env.FILO_LOCK_RETRY_BUDGET_MS);
  if (process.env.FILO_LOCK_RETRY_BUDGET_MS !== undefined && Number.isFinite(override) && override >= 0) {
    return override;
  }
  return process.platform === 'win32' ? 5000 : 310;
}

/**
 * Runs `op`, retrying while it fails with a Windows lock code until the
 * ELAPSED time reaches `budgetMs` (time-bounded, not count-bounded). Backoff:
 * 10, 20, 40, …, 640 ms, then 1000 ms capped. `beforeAttempt` runs before
 * EVERY attempt (its own throw is not retried unless it is a lock code). Any
 * non-lock error, or the budget running out, rethrows the last error.
 */
export async function retryOnWindowsLock<T>(
  op: () => Promise<T>,
  opts: { budgetMs?: number; beforeAttempt?: () => Promise<void> } = {},
): Promise<T> {
  const budgetMs = opts.budgetMs ?? lockRetryBudgetMs();
  const start = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      if (opts.beforeAttempt) await opts.beforeAttempt();
      return await op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (typeof code !== 'string' || !WIN_LOCK_CODES.has(code)) throw err;
      const elapsed = Date.now() - start;
      if (elapsed >= budgetMs) throw err;
      const step = LOCK_BACKOFF_MS[attempt] ?? LOCK_BACKOFF_CAP_MS;
      const delay = Math.max(1, Math.min(step, LOCK_BACKOFF_CAP_MS, budgetMs - elapsed));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Ensures a directory exists, creating it recursively if needed.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

