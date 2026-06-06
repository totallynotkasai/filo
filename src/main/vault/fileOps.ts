import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { join, extname, basename, resolve, sep } from 'path';
import { assertSafeFilename } from '../utils/pathSecurity';
import { recordPreservedEmergencyFile } from '../services/emergencyFileRegistry';
import type { FileTreeNode } from '../../shared/types';

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
 * Phase 1 / 1.5 — hard cap on `readDirectoryTree`. The previous cap was
 * applied AFTER the recursive walk completed, so pointing Filo at `~` or
 * `C:\` would still enumerate every entry into memory before refusing the
 * result. Threading a counter into the walk and throwing as soon as the
 * cap is exceeded means the main process aborts within bounded memory.
 *
 * 100 000 entries is comfortably above any realistic personal vault.
 */
export const VAULT_TREE_MAX_NODES = 100_000;

/**
 * Sprint B / B18 — secondary cap on the cumulative serialized size of the
 * tree. The node-count cap above is enough for typical vaults, but a
 * pathological mix (100K entries each with 500-char nested paths) can
 * still produce a ~50 MB JSON envelope that backs up the IPC channel
 * and stalls the renderer for seconds while it parses. 50 MB matches
 * the per-board payload cap and gives a comfortable ceiling for any
 * realistic vault.
 */
export const VAULT_TREE_MAX_SERIALIZED_BYTES = 50 * 1024 * 1024;

/**
 * Sprint B / B18 — typed error thrown when the cumulative serialized
 * byte budget is exhausted mid-walk. The IPC layer maps this to a
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
 * Phase 1 / 1.5 — typed error so the IPC layer can distinguish "this isn't
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
  // Audit-11 P2 — resolve the vault root to its real path ONCE so the
  // per-entry reparse-point check (see `walkDirectoryTree`) compares
  // real-vs-real: a junction inside the vault whose target escapes is then
  // reliably detected regardless of how the caller spelled the root. A
  // realpath failure (e.g. the root itself is gone) falls back to the raw
  // path — the walk's own readdir will surface the real error.
  let realRoot = dirPath;
  try {
    realRoot = await fs.realpath(dirPath);
  } catch {
    // keep dirPath
  }
  return walkDirectoryTree(dirPath, { count: 0, max, bytes: 0, maxBytes }, realRoot);
}

/**
 * Audit-11 P2 — true iff `candidate` (an absolute, realpath-resolved path)
 * is the vault root itself or lives beneath it. Used to exclude a reparse
 * point (NTFS junction / POSIX symlink) whose target escapes the vault.
 */
function isWithinVaultRoot(candidate: string, vaultRoot: string): boolean {
  const c = resolve(candidate);
  const r = resolve(vaultRoot);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

interface TreeWalkerCounter {
  count: number;
  max: number;
  // Sprint B / B18 — cumulative size of every node's path + name + the
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

    // Audit-11 P2 — exclude a reparse point (NTFS junction / POSIX symlink)
    // whose target escapes the vault, BEFORE counting it (mirroring the
    // hidden/.tmp skips above). libuv reports BOTH junctions and symlinks as a
    // link entry on Windows, so `isSymbolicLink()` flags them; `realpath` then
    // confirms the target stays inside the vault root. An escaping link is
    // dropped entirely — enumerating it would leak an out-of-vault path's name
    // into the sidebar (its contents are already guarded by the read IPC's
    // `assertWithinVault`). A within-vault link is enumerated normally; a
    // realpath failure (broken link / permission) is skipped. The `typeof`
    // guard keeps mock Dirents that predate `isSymbolicLink` working.
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

    // Sprint B / B18 — credit the cumulative serialized-size budget. Each
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
 * Phase 1 / 1.1 — typed error thrown when `renameItem` would silently
 * overwrite an existing destination. POSIX `fs.rename` clobbers the target
 * without warning; on Windows the operation fails with EEXIST, which the
 * IPC layer already classifies as a recoverable error code, but POSIX gave
 * us no signal at all. The renderer translates this code into a confirm
 * prompt so the user can decide whether to overwrite — without it, a stray
 * "rename A.md to B.md" call where B.md already exists silently destroys
 * the original B.md.
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
 * IMPL_PLAN_2026-05-26 / Item 2 — typed error thrown when a Windows
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
 * IMPL_PLAN_2026-05-26 / Item 2 — exponential backoff delays for retrying
 * the (tmp → newPath) leg of a Windows case-only rename. Mirrors the
 * `atomicWriteFile` retry table so behaviour is consistent across
 * write-path operations that hit transient Windows file-lock codes
 * (antivirus hold, indexer scan, EBUSY from a sibling handle).
 */
const CASE_RENAME_RETRY_DELAYS = [40, 80, 160, 320, 640] as const;

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
 * Phase 1 / 1.1 — pre-flight `fs.access(newPath)` so a POSIX rename can't
 * silently overwrite an existing target. On Windows `fs.rename` fails with
 * EEXIST/EPERM naturally; on POSIX it overwrites without warning. The
 * `RenameTargetExistsError` (`code: 'TARGET_EXISTS'`) lets the IPC layer
 * surface a typed code so the renderer can prompt before overwriting. A
 * pure case-only rename on Windows (different casing of the same path) is
 * excluded from the guard — the trampoline below handles it deliberately.
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
    await fs.rename(oldPath, tmp);
    // IMPL_PLAN_2026-05-26 / Item 2 — retry the (tmp → newPath) leg on
    // transient Windows file-lock codes (EBUSY/EPERM/EACCES) before
    // falling back to the rescue restore. Without this, an antivirus
    // hold or indexer scan that briefly grips the file between step 1
    // and step 2 strands the rename even though a few-hundred-ms wait
    // would have cleared it. Other error codes (ENOENT, EXDEV, etc.)
    // skip the retry — they will not clear by waiting.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= CASE_RENAME_RETRY_DELAYS.length; attempt++) {
      try {
        await fs.rename(tmp, newPath);
        return;
      } catch (err) {
        lastErr = err;
        const errCode = (err as NodeJS.ErrnoException | null)?.code;
        if (errCode !== 'EBUSY' && errCode !== 'EPERM' && errCode !== 'EACCES') break;
        if (attempt < CASE_RENAME_RETRY_DELAYS.length) {
          await new Promise((r) => setTimeout(r, CASE_RENAME_RETRY_DELAYS[attempt]));
        }
      }
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
    await fs.rename(oldPath, newPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'EXDEV') {
      const stat = await fs.stat(oldPath);
      if (stat.isDirectory()) throw err;
      await fs.copyFile(oldPath, newPath);
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
 * Phase 1 / 1.2 — typed error thrown when the unique-suffix loop can't
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
 * Copies a file into the vault. Returns the destination path.
 *
 * Phase 37 / 37.4 — the bare basename derived from `sourcePath` is run
 * through `assertSafeFilename` before it's joined into the target dir.
 * Without this guard a user dropping a file named `CON.png` /
 * `LPT1.txt` / `aux.mp3` from outside the vault would have a device
 * handle opened by `fs.copyFile` on Windows, which either silently
 * no-ops or hangs the IPC. The unique-suffix branch reruns the check on
 * every intermediate candidate so e.g. `CON (1).png` is rejected too.
 *
 * Phase 1 / 1.2 — atomic candidate-name selection via
 * `fs.open(..., 'wx')` (`O_WRONLY|O_CREAT|O_EXCL`). Two concurrent
 * copies of the same-basename files used to share a `fileExists(...)
 * → false` snapshot of the disk and race onto the same destination —
 * the first finished copy was overwritten by the second's rename. The
 * O_EXCL reservation makes the candidate selection collision-free:
 * whichever caller wins the open keeps that name; the loser bumps the
 * counter and retries, capped at {@link MAX_CANDIDATE_ATTEMPTS}.
 *
 * The bytes are streamed through the held fd in 64 KB chunks
 * (memory-bounded for large media), then `fsync`'d and the parent dir
 * is `fsync`'d so the new entry is durable. On non-fatal failure
 * (EACCES / EPERM / etc.) the partial file is unlinked; on
 * ENOSPC/EIO/ENOMEM the partial file is preserved at its final
 * destination and the path is attached to the rejected error via
 * `preservedTmpPath` so the IPC layer can name it in a toast (the
 * field name is retained for parity with the previous tmp+rename
 * contract — the path now points at the actual partial file, no `.tmp`
 * suffix).
 */
export async function copyFileToVault(
  sourcePath: string,
  vaultPath: string,
  subfolder?: string,
): Promise<string> {
  const targetDir = subfolder ? join(vaultPath, subfolder) : vaultPath;
  await fs.mkdir(targetDir, { recursive: true });

  const fileName = basename(sourcePath);
  // 6.3.P1/P2 — `copyFileToVault` copies an external file into the
  // vault as a NEW file; creation rules apply on every platform so the
  // resulting filename stays portable. Without `forCreation: true`, a
  // POSIX user dropping `weird:name.png` from outside the vault would
  // succeed locally but produce a file that breaks the same vault on
  // Windows.
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

  let writeErr: unknown = null;
  try {
    const source = await fs.open(sourcePath, 'r');
    try {
      const buf = Buffer.alloc(COPY_CHUNK_BYTES);
      let written = 0;
      // Sequential source read (position: null) + monotonically-increasing
      // dest offset. Chunked so a multi-GB media file doesn't sit in
      // memory in one allocation.
      while (true) {
        const { bytesRead } = await source.read(buf, 0, COPY_CHUNK_BYTES, null);
        if (bytesRead === 0) break;
        await dest.write(buf, 0, bytesRead, written);
        written += bytesRead;
      }
    } finally {
      await source.close().catch(() => undefined);
    }
    await dest.sync();
  } catch (err) {
    writeErr = err;
  } finally {
    await dest.close().catch(() => undefined);
  }

  if (writeErr) {
    const code = (writeErr as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOSPC' && code !== 'EIO' && code !== 'ENOMEM') {
      await fs.unlink(destPath).catch(() => undefined);
    } else if (writeErr && typeof writeErr === 'object') {
      (writeErr as { preservedTmpPath?: string }).preservedTmpPath = destPath;
      // 6.2.H4 (follow-up) — record the preserved partial copy so the quit
      // drain can surface its location via `.filo/quit-failure.json`.
      recordPreservedEmergencyFile({ preservedPath: destPath, targetPath: destPath, code });
    }
    throw writeErr;
  }

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
 * Reads a file and returns its contents as a UTF-8 string.
 */
export async function readFileContents(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
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
}

/**
 * 6.4.M7 — read a file's content with a coherent (mtime, size) baseline.
 *
 * The legacy `vault:read-file-text` handler did `stat → read`, so a write
 * landing in the gap meant the renderer recorded a baseline OLDER than
 * the bytes it actually received. The renderer's next drift check then
 * fired a spurious "modified externally" prompt for content that already
 * matched disk — the comment in the handler called this "the safe failure
 * direction", but the inverse race (write-then-read-then-stat) silently
 * pinned an OLDER baseline against the rendered NEWER bytes, masking real
 * future drift.
 *
 * This helper takes a stat snapshot BEFORE the read, reads the bytes,
 * then takes another stat snapshot AFTER. If the two stats agree on
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
    readFile?: (p: string) => Promise<string>;
  },
): Promise<CoherentReadResult | { tooLarge: true; size: number }> {
  const stat = _deps?.stat ?? (async (p) => fs.stat(p));
  const readFile = _deps?.readFile ?? readFileContents;

  const preStat = await stat(filePath);
  if (preStat.size > maxBytes) {
    return { tooLarge: true, size: preStat.size };
  }

  const content = await readFile(filePath);

  let postStat: { mtimeMs: number; size: number } | undefined;
  try {
    postStat = await stat(filePath);
  } catch {
    // Post-stat failed — return content with no baseline. ENOENT here
    // typically means a delete landed during the read; the renderer's
    // hydrate path will surface the missing file separately.
    return { content };
  }

  if (preStat.mtimeMs === postStat.mtimeMs && preStat.size === postStat.size) {
    return { content, mtimeMs: postStat.mtimeMs, size: postStat.size };
  }
  // Pre and post disagree — a write landed in the gap. Return bytes
  // without an unsafe baseline; the next quiescent read seeds coherently.
  return { content };
}
