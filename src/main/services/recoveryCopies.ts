/**
 * Settings → Recovery: opening and deleting the copies Filo keeps in
 * `.filo/recovery/` (kept versions, rescue copies, load-failure snapshots,
 * partly written files moved aside). Nothing prunes the kept versions and
 * rescue copies, so this is how the user clears them.
 *
 * Every path is one `listRecoverySnapshots` gave: a file inside the recovery
 * folder, never the folder itself or anything outside it. A delete goes to
 * the OS Recycle Bin; only when that refuses, and the user then confirms, is a
 * copy deleted for good.
 */
import { promises as fs } from 'fs';
import { dirname, extname, join } from 'path';
import { toPosix } from '../../shared/pathUtils';
import { assertWithinVault, FiloDirForbiddenError } from '../utils/pathSecurity';

const RECOVERY_SEGMENTS = ['.filo', 'recovery'] as const;
/** The sweep folder for partly written files (orphanTmpSweep.ts); its own folder is kept. */
const ORPHAN_TMP_DIR = 'orphan-tmp';

/** The copies Settings → Recovery opens in the system's app for them: text Filo wrote. */
const OPENABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json']);

/** A path these channels may not reach: a refusal like the `.filo/` guard's (FORBIDDEN). */
export class NotARecoveryCopyError extends FiloDirForbiddenError {
  constructor(relPath: string) {
    super(`FORBIDDEN: ${relPath} is not a copy in .filo/recovery`);
    this.name = 'NotARecoveryCopyError';
  }
}

/**
 * The absolute path of the recovery copy `relPath` (vault-relative, as the
 * listing gives it). A path outside `.filo/recovery/<folder>/`, or with an
 * empty, `.` or `..` segment, is refused.
 */
export function recoveryCopyPath(vaultRoot: string, relPath: string): string {
  const segments = toPosix(relPath).split('/');
  const inRecovery = segments.length >= 4
    && segments[0]?.toLowerCase() === RECOVERY_SEGMENTS[0]
    && segments[1]?.toLowerCase() === RECOVERY_SEGMENTS[1]
    && segments.every((s) => s !== '' && s !== '.' && s !== '..');
  if (!inRecovery) throw new NotARecoveryCopyError(relPath);
  const abs = join(vaultRoot, ...segments);
  assertWithinVault(join(vaultRoot, ...RECOVERY_SEGMENTS), abs);
  return abs;
}

/** The copy's path when it is a plain file (not a link, not a folder) the system may open. */
export async function openableRecoveryCopy(vaultRoot: string, relPath: string): Promise<string> {
  const abs = recoveryCopyPath(vaultRoot, relPath);
  if (!OPENABLE_EXTENSIONS.has(extname(abs).toLowerCase())) throw new NotARecoveryCopyError(relPath);
  if (!(await fs.lstat(abs)).isFile()) throw new NotARecoveryCopyError(relPath);
  return abs;
}

export interface DeletedRecoveryCopies {
  /** Gone: to the Recycle Bin, or (asked for) for good. */
  deleted: string[];
  /** The Recycle Bin wouldn't take these; they are still in `.filo/recovery`. */
  refused: string[];
  /** Couldn't be deleted at all (locked, or already gone). */
  failed: string[];
}

/**
 * Deletes each copy: to the Recycle Bin (`trashItem`), or with `permanently`
 * for good. A copy's folder goes too once it is empty, so the recovery folder
 * doesn't fill with empty timestamped folders.
 */
export async function deleteRecoveryCopies(
  vaultRoot: string,
  relPaths: readonly string[],
  opts: { permanently: boolean; trashItem: (absPath: string) => Promise<void> },
): Promise<DeletedRecoveryCopies> {
  const abses = relPaths.map((rel) => recoveryCopyPath(vaultRoot, rel));
  const out: DeletedRecoveryCopies = { deleted: [], refused: [], failed: [] };
  const folders = new Set<string>();
  for (let i = 0; i < abses.length; i++) {
    const abs = abses[i]!;
    const rel = relPaths[i]!;
    let isFolder: boolean;
    try {
      isFolder = (await fs.lstat(abs)).isDirectory();
    } catch {
      out.failed.push(rel);
      continue;
    }
    if (isFolder) {
      out.failed.push(rel);
      continue;
    }
    if (opts.permanently) {
      try {
        await fs.unlink(abs);
      } catch {
        out.failed.push(rel);
        continue;
      }
    } else {
      try {
        await opts.trashItem(abs);
      } catch {
        out.refused.push(rel);
        continue;
      }
    }
    out.deleted.push(rel);
    folders.add(dirname(abs));
  }
  for (const folder of folders) await removeIfEmpty(vaultRoot, folder);
  return out;
}

/** Removes a copy's timestamped folder once nothing is left in it (never the recovery or sweep folder itself). */
async function removeIfEmpty(vaultRoot: string, folder: string): Promise<void> {
  const recoveryRoot = join(vaultRoot, ...RECOVERY_SEGMENTS);
  const keep = [recoveryRoot, join(recoveryRoot, ORPHAN_TMP_DIR)].map((p) => toPosix(p).toLowerCase());
  if (keep.includes(toPosix(folder).toLowerCase())) return;
  try {
    if ((await fs.readdir(folder)).length === 0) await fs.rmdir(folder);
  } catch {
    // Gone already, or not empty after all: nothing to tidy.
  }
}
