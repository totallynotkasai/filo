import { promises as fs, constants as fsConstants } from 'fs';
import { isUtf8 } from 'buffer';
import type { FileHandle } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join, extname, basename, dirname, resolve, sep } from 'path';
import { assertSafeFilename } from '../utils/pathSecurity';
import {
  recordPreservedEmergencyFile,
  clearPreservedEmergencyFilesForTarget,
} from '../services/emergencyFileRegistry';
import type { FileTreeNode } from '../../shared/types';
import { retryOnWindowsLock, tmpSiblingPath } from './filenameUtils';

// `extname()` only returns the final segment, so `foo.board.json` → `.json`.
// Treat `.board.json` as a compound extension so the sidebar can strip it
// cleanly (display "foo" instead of "foo.board") and the rename input
// re-attaches the right suffix on commit.
function detectExtension(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.board.json')) return '.board.json';
  return extname(name).toLowerCase();
}

/**
 * Hard cap on `readDirectoryTree`, enforced DURING the walk so pointing
 * Filo at `~` or `C:\` aborts within bounded memory.
 *
 * 100 000 entries is comfortably above any realistic personal vault.
 */
export const VAULT_TREE_MAX_NODES = 100_000;

/**
 * Secondary cap on the cumulative serialized size of the tree: 100K
 * entries with long nested paths can still produce a ~50 MB JSON envelope
 * that stalls the renderer while it parses. Matches the per-board payload
 * cap.
 */
export const VAULT_TREE_MAX_SERIALIZED_BYTES = 50 * 1024 * 1024;

/**
 * Typed error thrown when the cumulative serialized byte budget is
 * exhausted mid-walk. The IPC layer maps this to a
 * `tree-too-large` envelope so the renderer can surface a friendlier
 * toast than the generic `IO_ERROR`.
 */
export class VaultTreeTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Vault directory tree exceeded ${limit} serialized bytes — refusing to enumerate`);
    this.name = 'VaultTreeTooLargeError';
    this.limit = limit;
  }
}

/**
 * Typed error so the IPC layer can distinguish "this isn't
 * a vault directory, this is the whole disk" from a generic IO failure
 * and surface a `vault:tree-too-large` toast to the renderer.
 */
export class VaultTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Vault directory tree exceeded ${limit} entries — refusing to enumerate`);
    this.name = 'VaultTooLargeError';
    this.limit = limit;
  }
}

/**
 * Recursively reads a directory and returns a FileTreeNode tree. Throws
 * `VaultTooLargeError` if the walker visits more than `maxNodes` entries
 * (defaults to `VAULT_TREE_MAX_NODES`).
 *
 * The optional `maxNodes` parameter is a test seam — production callers
 * pass nothing and get the default cap. Unit tests pass a small cap
 * (e.g. 100) to verify the in-walk throw without allocating 100 000
 * mock dirents.
 */
export async function readDirectoryTree(
  dirPath: string,
  options: { maxNodes?: number; maxSerializedBytes?: number } = {},
): Promise<FileTreeNode[]> {
  const max = options.maxNodes ?? VAULT_TREE_MAX_NODES;
  const maxBytes = options.maxSerializedBytes ?? VAULT_TREE_MAX_SERIALIZED_BYTES;
  // Resolve the vault root to its real path ONCE so the per-entry
  // reparse-point check compares real-vs-real, regardless of how the caller
  // spelled the root. On realpath failure fall back to the raw path — the
  // walk's own readdir will surface the real error.
  let realRoot = dirPath;
  try {
    realRoot = await fs.realpath(dirPath);
  } catch {
    // keep dirPath
  }
  return walkDirectoryTree(dirPath, { count: 0, max, bytes: 0, maxBytes }, realRoot);
}

/**
 * True iff `candidate` (an absolute, realpath-resolved path) is the vault
 * root itself or lives beneath it. Used to exclude a reparse point (NTFS
 * junction / POSIX symlink) whose target escapes the vault.
 *
 * Case-folds both sides on Windows (mirrors `assertWithinVault`): NTFS is
 * case-insensitive, so `C:\VAULT\sub` vs a `C:\vault` root must still count
 * as inside.
 */
function isWithinVaultRoot(candidate: string, vaultRoot: string): boolean {
  const isWin = process.platform === 'win32';
  const c0 = resolve(candidate);
  const r0 = resolve(vaultRoot);
  const c = isWin ? c0.toLowerCase() : c0;
  const r = isWin ? r0.toLowerCase() : r0;
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

interface TreeWalkerCounter {
  count: number;
  max: number;
  // Cumulative size of every node's path + name + the
  // fixed per-node JSON envelope overhead (`{}`, quotes, field names).
  // Tracked alongside the entry count so a vault with deep paths
  // doesn't slip past the cap.
  bytes: number;
  maxBytes: number;
}

async function walkDirectoryTree(
  dirPath: string,
  counter: TreeWalkerCounter,
  vaultRoot: string = dirPath,
): Promise<FileTreeNode[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];

  for (const entry of entries) {
    // Skip hidden files/folders and system files
    if (entry.name.startsWith('.')) continue;
    // Skip atomicWriteFile transients. Without this, a vault tree refresh
    // that races a self-write briefly shows both `foo.board.json` and
    // `foo.board.json.tmp` in the sidebar — perceived as a flicker as the
    // .tmp file appears and disappears within ~10ms.
    if (entry.name.endsWith('.tmp') || entry.name.endsWith('.bak')) continue;

    const fullPath = join(dirPath, entry.name);

    // Exclude a reparse point (NTFS junction / POSIX symlink) whose target
    // escapes the vault, BEFORE counting it. libuv reports both as a link
    // entry on Windows; `realpath` confirms the target. Enumerating an
    // escaping link would leak an out-of-vault path's name into the sidebar.
    // A broken link / permission failure is skipped. The `typeof` guard keeps
    // mock Dirents without `isSymbolicLink` working.
    if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = await fs.realpath(fullPath);
      } catch {
        continue;
      }
      if (!isWithinVaultRoot(realTarget, vaultRoot)) continue;
    }

    counter.count++;
    if (counter.count > counter.max) {
      throw new VaultTooLargeError(counter.max);
    }

    // Credit the cumulative serialized-size budget. Each
    // node's two string fields (`path`, `name`) dominate JSON size; the
    // fixed 200-byte overhead covers field names, quotes, and the
    // surrounding object. Throw as soon as the running total exceeds
    // the cap so the walker can bail without continuing the recursion.
    counter.bytes += entry.name.length + fullPath.length + 200;
    if (counter.bytes > counter.maxBytes) {
      throw new VaultTreeTooLargeError(counter.maxBytes);
    }

    if (entry.isDirectory()) {
      const children = await walkDirectoryTree(fullPath, counter, vaultRoot);
      nodes.push({
        name: entry.name,
        path: fullPath,
        isDirectory: true,
        children,
      });
    } else {
      let modifiedAt: number | undefined;
      let sizeBytes: number | undefined;
      try {
        const stat = await fs.stat(fullPath);
        modifiedAt = stat.mtimeMs;
        sizeBytes = stat.size;
      } catch {
        // stat may fail on locked files; skip timestamp / size
      }

      nodes.push({
        name: entry.name,
        path: fullPath,
        isDirectory: false,
        extension: detectExtension(entry.name),
        modifiedAt,
        sizeBytes,
      });
    }
  }

  return nodes;
}

/**
 * Creates a new folder at the given path.
 */
export async function createFolder(folderPath: string): Promise<void> {
  await fs.mkdir(folderPath, { recursive: true });
}

/**
 * Typed error thrown when `renameItem` would overwrite an existing
 * destination. POSIX `fs.rename` clobbers the target without warning; the
 * renderer turns this code into a confirm prompt so renaming A.md onto an
 * existing B.md never silently destroys B.md.
 */
export class RenameTargetExistsError extends Error {
  readonly code = 'TARGET_EXISTS' as const;
  readonly destPath: string;
  constructor(destPath: string) {
    super(`Rename target already exists: ${destPath}`);
    this.name = 'RenameTargetExistsError';
    this.destPath = destPath;
  }
}

/**
 * Typed error thrown when a Windows
 * case-only rename trampoline (`Notes.md` → tmp → `notes.md`) succeeds
 * at step 1 but every retry of step 2 fails AND the rescue rename back
 * to the original path also fails. In that pathological case the file
 * is sitting on disk under the `.case-rename-<ts>` temp name; surfacing
 * the path through the error lets the IPC handler include it in the
 * rename-failure toast so the user can recover the file from File
 * Explorer rather than thinking it was lost.
 */
export class CaseRenameStrandedError extends Error {
  readonly code = 'IO_ERROR' as const;
  readonly strandedAt: string;
  readonly originalPath: string;
  readonly cause: unknown;
  constructor(strandedAt: string, originalPath: string, cause: unknown) {
    super(
      `Case-only rename failed; file is at ${strandedAt} ` +
      `(intended ${originalPath}). Restore failed: ${String(cause)}`,
    );
    this.name = 'CaseRenameStrandedError';
    this.strandedAt = strandedAt;
    this.originalPath = originalPath;
    this.cause = cause;
  }
}


/**
 * Renames a file or folder.
 *
 * Two platform-specific quirks are handled here so the IPC layer can stay
 * thin:
 *
 *   - Windows case-only rename (`Notes.md` → `notes.md`): NTFS treats the
 *     two paths as the same file, so a direct `fs.rename` is a no-op and
 *     leaves the original casing in place. We trampoline through a
 *     timestamped temp name to force the casing through.
 *   - Cross-filesystem move (`EXDEV`): a vault that spans drive letters
 *     (e.g. a folder mounted from another disk) rejects `rename` with
 *     `EXDEV`. Fall back to copy-then-unlink for files; folders are not
 *     covered here because no caller currently moves a folder across
 *     filesystems and `fs.rename` would have to be replaced with a
 *     recursive walk to make that work.
 *
 * A pre-flight `fs.access(newPath)` throws `RenameTargetExistsError` so a
 * POSIX rename can't silently overwrite an existing target. A Windows
 * case-only rename is excluded — the trampoline handles it deliberately.
 */
export async function renameItem(oldPath: string, newPath: string): Promise<void> {
  const isCaseOnlyRenameOnWindows =
    process.platform === 'win32' &&
    oldPath !== newPath &&
    oldPath.toLowerCase() === newPath.toLowerCase();

  if (oldPath !== newPath && !isCaseOnlyRenameOnWindows) {
    try {
      await fs.access(newPath);
      // access() succeeded → the target exists. Refuse to overwrite.
      throw new RenameTargetExistsError(newPath);
    } catch (err) {
      if (err instanceof RenameTargetExistsError) throw err;
      const code = (err as NodeJS.ErrnoException | null)?.code;
      // ENOENT is the happy path — target doesn't exist, proceed with the
      // rename. Any other access() failure (EACCES, EPERM, …) is rethrown
      // so the renderer sees the underlying reason rather than masking it
      // as "target exists".
      if (code !== 'ENOENT') throw err;
    }
  }

  if (isCaseOnlyRenameOnWindows) {
    const tmp = `${oldPath}.case-rename-${Date.now()}`;
    await retryOnWindowsLock(() => fs.rename(oldPath, tmp));
    // Retry the (tmp → newPath) leg on transient Windows lock codes with the
    // shared time-bounded backoff before falling back to the rescue restore. An antivirus / sync-client
    // hold between step 1 and step 2 would otherwise strand the rename.
    let lastErr: unknown = null;
    try {
      await retryOnWindowsLock(() => fs.rename(tmp, newPath));
      return;
    } catch (err) {
      lastErr = err;
    }
    // Step 2 still failing — restore the file at its original path so
    // the rename is a complete no-op from the user's perspective. If
    // the rescue ALSO fails, the file is on disk under `tmp` and we
    // throw a typed `CaseRenameStrandedError` carrying that path so
    // the IPC layer can name the location in the toast.
    try {
      await fs.rename(tmp, oldPath);
    } catch (rescueErr) {
      throw new CaseRenameStrandedError(tmp, oldPath, lastErr ?? rescueErr);
    }
    throw lastErr;
  }
  try {
    // Windows returns EPERM for a directory rename while
    // OneDrive / Explorer holds a child handle; retry that before failing. The
    // EXDEV branch below runs only after the lock retry, on its own code.
    await retryOnWindowsLock(() => fs.rename(oldPath, newPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'EXDEV') {
      const stat = await fs.stat(oldPath);
      if (stat.isDirectory()) throw err;
      // Cross-device move. Stage into a temp, fsync, atomically rename,
      // best-effort dir-fsync, THEN unlink the source, so a crash mid-copy
      // never leaves a torn file at `newPath` with the source gone.
      const nonce = randomBytes(6).toString('hex');
      const tmpPath = tmpSiblingPath(newPath, nonce);
      try {
        await fs.copyFile(oldPath, tmpPath);
        const fh = await fs.open(tmpPath, 'r+');
        try {
          await fh.sync();
        } finally {
          await fh.close().catch(() => undefined);
        }
        await fs.rename(tmpPath, newPath);
      } catch (copyErr) {
        await fs.unlink(tmpPath).catch(() => undefined);
        throw copyErr;
      }
      try {
        const dirHandle = await fs.open(dirname(newPath), 'r');
        try { await dirHandle.sync(); } catch { /* dir fsync unsupported */ }
        await dirHandle.close().catch(() => undefined);
      } catch { /* dir handle open failed — non-fatal */ }
      await fs.unlink(oldPath);
      return;
    }
    throw err;
  }
}

/**
 * Deletes a file or folder (recursive for folders).
 *
 * Treats ENOENT on the initial stat as a no-op success — the caller's goal
 * is "this path must not exist after we return", and a missing path already
 * satisfies that. Without this, any path-resolver drift on the delete side
 * produces a noisy `Failed to delete: ENOENT` log from the IPC layer even
 * though the user-visible state is correct.
 */
export async function deleteItem(itemPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(itemPath);
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') return;
    throw err;
  }
  if (stat.isDirectory()) {
    await fs.rm(itemPath, { recursive: true, force: true });
  } else {
    await fs.unlink(itemPath);
  }
}

/**
 * Typed error thrown when the unique-suffix loop can't
 * find a free name within {@link MAX_CANDIDATE_ATTEMPTS} attempts. A
 * realistic upload set won't come close to 1000 same-basename collisions;
 * hitting the cap usually indicates the target directory is unwritable
 * to a degree the bare EEXIST surface would otherwise hide.
 */
export class TargetNameExhaustedError extends Error {
  readonly code = 'TARGET_NAME_EXHAUSTED' as const;
  readonly attempts: number;
  readonly baseName: string;
  constructor(baseName: string, attempts: number) {
    super(`No free filename for "${baseName}" after ${attempts} attempts`);
    this.name = 'TargetNameExhaustedError';
    this.attempts = attempts;
    this.baseName = baseName;
  }
}

const MAX_CANDIDATE_ATTEMPTS = 1000;
const COPY_CHUNK_BYTES = 64 * 1024;

/**
 * Opens a copy SOURCE while defeating a regular-file→SYMLINK swap
 * that lands between the handler's pre-flight `lstat` and this open.
 * `copyFileToVault`'s fstat `.isFile()` re-check catches a swap to a
 * device/dir/FIFO, but `fs.open(path,'r')` FOLLOWS a symlink, so a swap to a
 * symlink pointing at a regular file (e.g. `/etc/passwd`) would fstat as a file
 * and slip through.
 *
 *   - POSIX: open with `O_NOFOLLOW`, so the open itself fails (`ELOOP`) when the
 *     final path component is a symlink. Solid, with no false positives (a real
 *     regular-file source is never a symlink).
 *   - Windows: no `O_NOFOLLOW`, and no fd→path API without native bindings, so
 *     `lstat` immediately before the open and refuse a symlink. This narrows the
 *     TOCTOU window to a couple of instructions WITHOUT the false-positive risk
 *     a realpath/casing comparison carries (8.3 short names, junction parents).
 *
 * Gated on `noFollow` — `vault:copy-file` sets it; default-`false` non-IPC
 * callers keep the plain `'r'` open unchanged.
 */
async function openSourceForCopy(sourcePath: string, noFollow: boolean): Promise<FileHandle> {
  if (!noFollow) return fs.open(sourcePath, 'r');
  if (process.platform === 'win32') {
    const pre = await fs.lstat(sourcePath);
    if (pre.isSymbolicLink()) {
      throw new Error('Source is a symlink (changed after pre-flight check)');
    }
    return fs.open(sourcePath, 'r');
  }
  const noFollowFlag = (fsConstants.O_NOFOLLOW as number | undefined) ?? 0;
  return fs.open(sourcePath, fsConstants.O_RDONLY | noFollowFlag);
}

/**
 * Copies a file into the vault. Returns the destination path.
 *
 * The basename (and every ` (n)` candidate) goes through
 * `assertSafeFilename`, so a dropped `CON.png` / `LPT1.txt` can't open a
 * Windows device handle.
 *
 * The destination name is reserved with an O_EXCL open (`'wx'`), so two
 * concurrent same-basename copies can't race onto one destination; the loser
 * bumps the counter, capped at {@link MAX_CANDIDATE_ATTEMPTS}.
 *
 * The placeholder is only a NAME claim: bytes stream in 64 KB chunks into a
 * sibling `<dest>.<nonce>.tmp`, are fsync'd, then atomically renamed OVER the
 * placeholder, so the final name never holds a torn file. On a non-fatal
 * failure the temp and placeholder are unlinked; on ENOSPC/EIO/ENOMEM (or an
 * exhausted rename) the temp is preserved (it may be the user's only copy)
 * and attached to the error as `preservedTmpPath` for the toast.
 *
 * TOCTOU hardening: the source is re-stat'd through the open fd (catching a
 * device/FIFO/dir swapped in after the caller's lstat), the bytes STREAMED
 * are capped at `maxBytes` (defeating a `/dev/zero`-style device), and
 * `noFollowSource` defeats a symlink swap (see `openSourceForCopy`). Which
 * paths may be a source is enforced upstream via `isApprovedCopySource`.
 */
export async function copyFileToVault(
  sourcePath: string,
  vaultPath: string,
  subfolder?: string,
  maxBytes: number = Number.POSITIVE_INFINITY,
  noFollowSource = false,
): Promise<string> {
  const targetDir = subfolder ? join(vaultPath, subfolder) : vaultPath;
  await fs.mkdir(targetDir, { recursive: true });

  const fileName = basename(sourcePath);
  // Creates a NEW file, so creation rules apply on every platform: a POSIX
  // `weird:name.png` would otherwise break the same vault on Windows.
  assertSafeFilename(fileName, { forCreation: true });
  const ext = extname(fileName);
  const nameWithoutExt = fileName.slice(0, fileName.length - ext.length);

  let destPath = '';
  let dest: FileHandle | null = null;
  for (let attempt = 0; attempt < MAX_CANDIDATE_ATTEMPTS; attempt++) {
    const candidate =
      attempt === 0 ? fileName : `${nameWithoutExt} (${attempt})${ext}`;
    if (attempt > 0) assertSafeFilename(candidate, { forCreation: true });
    const candidatePath = join(targetDir, candidate);
    try {
      dest = await fs.open(candidatePath, 'wx');
      destPath = candidatePath;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'EEXIST') continue;
      throw err;
    }
  }
  if (!dest) throw new TargetNameExhaustedError(fileName, MAX_CANDIDATE_ATTEMPTS);
  // The O_EXCL open RESERVED the destination NAME as a 0-byte placeholder
  // (collision-free vs a concurrent same-basename copy). It is only a name claim;
  // close it now — the bytes go into a sibling temp that is renamed OVER the
  // placeholder so the final name never holds a torn partial.
  await dest.close().catch(() => undefined);

  const nonce = randomBytes(6).toString('hex');
  const tmpPath = tmpSiblingPath(destPath, nonce);
  let writeErr: unknown = null;
  let tmp: FileHandle | null = null;
  try {
    tmp = await fs.open(tmpPath, 'wx');
    const source = await openSourceForCopy(sourcePath, noFollowSource);
    try {
      // Re-stat through the OPEN fd: `fstat` reports what we ACTUALLY opened,
      // so a source swapped to a device / FIFO / directory after the
      // handler's pre-flight lstat is caught here instead of streamed.
      const openedStat = await source.stat();
      if (!openedStat.isFile()) {
        throw new Error('Source is not a regular file (changed after pre-flight check)');
      }
      const buf = Buffer.alloc(COPY_CHUNK_BYTES);
      let written = 0;
      // Sequential source read (position: null) + monotonically-increasing
      // temp offset. Chunked so a multi-GB media file doesn't sit in
      // memory in one allocation.
      while (true) {
        const { bytesRead } = await source.read(buf, 0, COPY_CHUNK_BYTES, null);
        if (bytesRead === 0) break;
        await tmp.write(buf, 0, bytesRead, written);
        written += bytesRead;
        // Cap the BYTES STREAMED, not just the pre-read `size`: a device that
        // never EOFs (`/dev/zero`) or a file that grows mid-copy would
        // otherwise fill the disk.
        if (written > maxBytes) {
          throw new Error(`Source exceeded the ${maxBytes}-byte copy cap mid-stream`);
        }
      }
    } finally {
      await source.close().catch(() => undefined);
    }
    await tmp.sync();
  } catch (err) {
    writeErr = err;
  } finally {
    if (tmp) await tmp.close().catch(() => undefined);
  }

  if (writeErr) {
    // The bytes never reached the final name (it is still the 0-byte
    // placeholder), so drop the placeholder unconditionally — only the temp can
    // hold recoverable data. On a non-fatal failure clean up the temp too; on
    // ENOSPC/EIO/ENOMEM preserve it (its partial bytes may be the user's only
    // copy) and attach the temp path for the toast.
    const code = (writeErr as NodeJS.ErrnoException | null)?.code;
    await fs.unlink(destPath).catch(() => undefined);
    if (code !== 'ENOSPC' && code !== 'EIO' && code !== 'ENOMEM') {
      await fs.unlink(tmpPath).catch(() => undefined);
    } else if (writeErr && typeof writeErr === 'object') {
      (writeErr as { preservedTmpPath?: string }).preservedTmpPath = tmpPath;
      // Record the preserved partial copy so the quit
      // drain can surface its location via `.filo/quit-failure.json`.
      recordPreservedEmergencyFile({ preservedPath: tmpPath, targetPath: destPath, code });
    }
    throw writeErr;
  }

  // Atomically swap the fully-written, fsync'd temp OVER the reserved
  // placeholder. Retry on transient Windows lock codes (EPERM/EBUSY/EACCES from
  // antivirus / the recursive watch handle) before giving up; if the rename
  // still can't land, the intact temp is preserved for recovery.
  let renamed = false;
  let renameErr: unknown = null;
  try {
    // The shared time-bounded Windows lock backoff.
    await retryOnWindowsLock(() => fs.rename(tmpPath, destPath));
    renamed = true;
  } catch (err) {
    renameErr = err;
  }
  if (!renamed) {
    await fs.unlink(destPath).catch(() => undefined);
    const code = (renameErr as NodeJS.ErrnoException | null)?.code;
    if (renameErr && typeof renameErr === 'object') {
      (renameErr as { preservedTmpPath?: string }).preservedTmpPath = tmpPath;
      recordPreservedEmergencyFile({ preservedPath: tmpPath, targetPath: destPath, code });
    }
    throw renameErr;
  }

  // The copy landed: drop registry entries a prior failed
  // copy to this destination recorded (mirrors atomicWriteFile; the
  // preserved partial `.tmp` stays on disk).
  clearPreservedEmergencyFilesForTarget(destPath);

  // Best-effort directory fsync so the new entry is durably visible
  // across an unclean shutdown. Some filesystems (FAT, certain network
  // mounts) don't support dir fsync — swallow the failure.
  try {
    const dirHandle = await fs.open(targetDir, 'r');
    try { await dirHandle.sync(); } catch { /* dir fsync unsupported */ }
    await dirHandle.close().catch(() => undefined);
  } catch { /* dir handle open failed — non-fatal */ }

  return destPath;
}

/**
 * Outcome of {@link readFileWithCoherentStat}. `content` is always present
 * on success; `mtimeMs` and `size` are present only when the pre-read stat
 * and post-read stat agree (i.e. no external write landed in the gap).
 *
 * Callers seed their drift baseline from `mtimeMs`/`size`; when they're
 * `undefined`, the baseline is deliberately NOT seeded — a fresh hydrate
 * or successful self-write will reseed once a coherent (content, stat)
 * pair can be observed.
 */
export interface CoherentReadResult {
  content: string;
  mtimeMs?: number;
  size?: number;
  /**
   * Whether the bytes were valid UTF-8. `content` is still
   * decoded (U+FFFD for bad sequences) so the note can be DISPLAYED, but an
   * `'invalid-utf-8'` file must never be written back from that text.
   */
  encoding: 'utf-8' | 'invalid-utf-8';
}

/**
 * Read a file's content with a coherent (mtime, size) baseline.
 *
 * A plain `stat → read` lets a write in the gap pair a baseline with bytes
 * from the other side of it, which either fires a spurious "modified
 * externally" prompt or masks real future drift. So this takes a stat
 * snapshot BEFORE the read, reads the bytes, then another AFTER. If the two stats agree on
 * `mtimeMs` and `size`, the read is coherent and we return all three; if
 * they disagree, the content we read may be from either side of the gap
 * — we return `content` (so the caller still gets bytes) but withhold
 * `mtimeMs`/`size` so the renderer skips seeding a possibly-wrong
 * baseline. A subsequent successful read on a quiescent file will
 * succeed coherently and reseed.
 *
 * The size cap is enforced from the pre-read stat (cheapest place to
 * refuse a 25 GB file before reading any bytes).
 *
 * Optional `_deps` lets tests inject `stat`/`readFile` mocks without
 * monkey-patching the global `fs.promises` namespace. Production callers
 * omit it and the real `fs.promises` is used.
 */
export async function readFileWithCoherentStat(
  filePath: string,
  maxBytes: number,
  _deps?: {
    stat?: (p: string) => Promise<{ mtimeMs: number; size: number }>;
    readFile?: (p: string) => Promise<string | Buffer>;
  },
): Promise<CoherentReadResult | { tooLarge: true; size: number }> {
  const stat = _deps?.stat ?? (async (p) => fs.stat(p));
  const readFile = _deps?.readFile ?? ((p: string) => fs.readFile(p));

  const preStat = await stat(filePath);
  if (preStat.size > maxBytes) {
    return { tooLarge: true, size: preStat.size };
  }

  // Validate, don't guess: a Buffer read + `isUtf8` (a string
  // from a test double is trusted as valid).
  const raw = await readFile(filePath);
  const encoding: CoherentReadResult['encoding'] =
    typeof raw === 'string' || isUtf8(raw) ? 'utf-8' : 'invalid-utf-8';
  const content = typeof raw === 'string' ? raw : raw.toString('utf8');

  let postStat: { mtimeMs: number; size: number } | undefined;
  try {
    postStat = await stat(filePath);
  } catch {
    // Post-stat failed — return content with no baseline. ENOENT here
    // typically means a delete landed during the read; the renderer's
    // hydrate path will surface the missing file separately.
    return { content, encoding };
  }

  if (preStat.mtimeMs === postStat.mtimeMs && preStat.size === postStat.size) {
    return { content, mtimeMs: postStat.mtimeMs, size: postStat.size, encoding };
  }
  // Pre and post disagree — a write landed in the gap. Return bytes
  // without an unsafe baseline; the next quiescent read seeds coherently.
  return { content, encoding };
}
