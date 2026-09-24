/**
 * recoverySnapshot — preserves a vault file's bytes before Filo can clobber
 * them. Triggered when the renderer fails to load a file but the file on
 * disk is intact (parse / schema-invalid), so the user can recover by
 * editing the original outside Filo.
 *
 * Snapshots land in `<vault>/.filo/recovery/<timestamp>/<flattened-path>`
 * (the rel path's segments joined with `__`, so same-named files in
 * different folders neither collide nor share a prune bucket). The
 * directory is created on demand; older snapshots beyond
 * `MAX_SNAPSHOTS_PER_BASENAME` (per flattened path) are pruned automatically
 * so a long-lived vault doesn't accumulate hundreds of `.board.json` copies
 * after a flaky write window.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { assertWithinVault } from '../utils/pathSecurity';
import { atomicWriteFile, ensureDir } from '../vault/filenameUtils';
import { parseSentinelBasename } from '../../shared/sentinelPaths';
import { logMainError } from '../utils/mainLogger';

const RECOVERY_DIR = join('.filo', 'recovery');

/**
 * Basenames of Filo's own crash-recovery sentinels. A vault
 * file that happens to share one of these names (or a sentinel's bytes copied
 * in for forensics) is NOT a user-recoverable document, so `listRecoverySnapshots`
 * filters them out — surfacing a `.dirty` / `*-pending.json` in the "preserved
 * snapshots" prompt only confuses the user (there's nothing to recover from a
 * sentinel). Kept in sync with the sentinel paths in `dirtyFlagRecovery.ts`,
 * `tagRewriteSentinel.ts`, `renameCascadeSentinel.ts`, `quitFailureRecovery.ts`.
 */
// Per-machine forms (`.dirty.<id>`, `quit-failure.<id>.json` …): one matcher
// in src/shared/sentinelPaths.ts.
const isSentinelBasename = (name: string): boolean => parseSentinelBasename(name) !== null;

/**
 * Sentinel snapshots are stored under their FLATTENED rel path
 * (`.filo/.dirty` → `.filo__.dirty`), so match the final `__`-segment as
 * well as the bare name (older snapshots keep the bare basename).
 */
function isSentinelSnapshotName(name: string): boolean {
  if (isSentinelBasename(name)) return true;
  const lastSegment = name.split('__').pop();
  return lastSegment !== undefined && isSentinelBasename(lastSegment);
}

/**
 * Per-basename retention cap. Each failed-load preserves one copy in a
 * timestamped subdirectory; once a given basename has more than this many
 * copies across all `.filo/recovery/*` subdirs, the oldest are removed
 * (and any subdirectory that becomes empty is rmdir'd). 20 is generous
 * enough to cover a bad-write incident plus a few weeks of follow-up
 * editing without growing unbounded.
 */
const MAX_SNAPSHOTS_PER_BASENAME = 20;

/**
 * Global cap across every basename. Even with per-basename pruning, a vault
 * that suffers a wide multi-file corruption (e.g. an external sync client
 * corrupting 50 boards) could leave hundreds of snapshots scattered across
 * timestamp subdirs. After the per-basename prune runs, this second pass
 * walks the entire recovery tree and removes the oldest files until the
 * total drops below this cap. 100 survives a realistic multi-file
 * corruption window while bounding the worst-case disk footprint.
 */
const MAX_SNAPSHOTS_TOTAL = 100;

/**
 * Per-snapshot byte cap, so a misbehaving caller can't fill the disk with
 * copies of a multi-GB file. 25 MB is generous for `.board.json` and any
 * realistic markdown file (100 × 25 MB still bounds the directory at 2.5 GB).
 *
 * Oversize files throw `RECOVERY_SNAPSHOT_TOO_LARGE`; the renderer treats
 * snapshot failures as non-fatal (the snapshot is a defensive backup).
 */
const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

/**
 * Flattens a vault-relative path into a single snapshot filename by joining
 * its segments with `__` (e.g. `folderA/Notes.md` → `folderA__Notes.md`).
 * Keeping the folder means two same-basename files snapshotted in the same
 * ms can't collide, and snapshots of `folderB/Notes.md` can't prune away
 * every preserved copy of `folderA/Notes.md`.
 *
 * Defensive tail-truncation: a pathologically deep rel path could push the
 * flattened name past the OS filename limit (~255 bytes). Keep the LAST
 * 180 chars — the deep tail (including the real basename) is what
 * distinguishes files; the lost prefix only risks a collision between two
 * near-identical deep paths, which then share a prune bucket (bounded loss,
 * no crash).
 */
export function flattenSnapshotName(relativePath: string): string {
  const flat = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('__');
  return flat.length > 180 ? flat.slice(flat.length - 180) : flat;
}

/**
 * Copies `<vault>/<relativePath>` into
 * `<vault>/.filo/recovery/<ts>/<flattened-rel-path>`.
 *
 * `relativePath` is validated against `assertWithinVault` so an attacker
 * who reaches this handler can't snapshot an arbitrary OS file into the
 * vault.
 *
 * Returns the absolute path of the copy so the caller can surface it to
 * the user if needed. Throws on I/O failures of the copy step — the
 * caller logs and continues; recovery snapshots are best-effort, not a
 * precondition for the rest of the load. Prune failures (a permission
 * error on the timestamped subdirectory, etc.) are swallowed because they
 * don't affect the fresh snapshot's integrity.
 */
export async function snapshotForRecovery(
  vaultRoot: string,
  relativePath: string,
): Promise<string> {
  const sourceAbs = join(vaultRoot, relativePath);
  assertWithinVault(vaultRoot, sourceAbs);

  // ISO timestamp with ms-resolution and `:` swapped for `-` (illegal on
  // Windows filenames). The `.SSS` fractional segment keeps two snapshots
  // taken in the same second in distinct subdirectories.
  const timestamp = new Date().toISOString().replace(/[:]/g, '-').replace(/Z$/, '');
  const destDir = join(vaultRoot, RECOVERY_DIR, timestamp);
  await ensureDir(destDir);

  // Flattened rel path, not the bare basename (see flattenSnapshotName).
  const destAbs = join(destDir, flattenSnapshotName(relativePath));

  // Size check BEFORE the read so a multi-GB file isn't pulled into memory
  // just to be rejected.
  const sourceStat = await fs.stat(sourceAbs);
  if (sourceStat.size > MAX_SNAPSHOT_BYTES) {
    const err = new Error(
      `Refusing to snapshot ${relativePath}: ${sourceStat.size} bytes exceeds ${MAX_SNAPSHOT_BYTES}-byte cap`,
    );
    (err as NodeJS.ErrnoException).code = 'RECOVERY_SNAPSHOT_TOO_LARGE';
    throw err;
  }

  // read-then-atomicWriteFile rather than fs.copyFile so the snapshot
  // survives power loss: `copyFile` returns once data is in the kernel
  // cache, and a torn safety net would lie.
  const bytes = await fs.readFile(sourceAbs);
  await atomicWriteFile(destAbs, bytes);

  // Prune older snapshots of the same file. Best-effort, but logged so an
  // iffy-permissions vault doesn't accumulate snapshots invisibly.
  await pruneOldSnapshotsForBasename(vaultRoot, flattenSnapshotName(relativePath)).catch((err) => {
    logMainError('recovery:snapshot:prune', err);
  });

  // Second pass: cap the total snapshot count across every
  // basename. Per-basename pruning alone leaves room for unbounded growth
  // when many distinct files get snapshotted in a short window (e.g. one
  // bad sync run corrupting 50 boards). Best-effort, same swallowed-error
  // contract as the per-basename pass.
  await pruneOldSnapshotsGlobal(vaultRoot).catch((err) => {
    logMainError('recovery:snapshot:prune-global', err);
  });

  return destAbs;
}

/**
 * Walks `.filo/recovery/*` looking for snapshots named `targetName` (the
 * flattened rel path), sorts them by mtime ascending (oldest first), and
 * deletes everything past the most recent `MAX_SNAPSHOTS_PER_BASENAME`.
 * Empty timestamp subdirectories are removed after their last file goes.
 *
 * Defensive: every fs operation that could plausibly fail is wrapped so a
 * single permission error doesn't abort the rest of the prune. We never
 * descend below the timestamp subdirs because there shouldn't be any —
 * each snapshot writes a single file directly into `<ts>/`.
 */
async function pruneOldSnapshotsForBasename(
  vaultRoot: string,
  targetName: string,
): Promise<void> {
  const recoveryRoot = join(vaultRoot, RECOVERY_DIR);
  let entries: Array<{ name: string; isDirectory: boolean }>;
  try {
    const dirEntries = await fs.readdir(recoveryRoot, { withFileTypes: true });
    entries = dirEntries.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch (err) {
    // ENOENT is benign — the recovery directory hasn't been created yet on
    // the first snapshot of this vault, so there's nothing to prune.
    // Anything else (EACCES on a locked-down network share, ENOTDIR if a
    // user planted a file at `.filo/recovery`, …) is worth surfacing so
    // an unbounded growth condition doesn't go invisible.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const matches: Array<{ filePath: string; subdirPath: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const subdirPath = join(recoveryRoot, entry.name);
    const filePath = join(subdirPath, targetName);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      matches.push({ filePath, subdirPath, mtime: stat.mtimeMs });
    } catch {
      // No matching file in this subdir, or stat failed — skip.
    }
  }
  if (matches.length <= MAX_SNAPSHOTS_PER_BASENAME) return;

  // Lexicographic tiebreak when mtimes collide on the millisecond
  // (e.g. two snapshots taken in the same ms when the filesystem only
  // reports second-level granularity, or on platforms where mtimeMs is
  // truncated). The timestamped subdir path is the ISO-8601 string from
  // `snapshotForRecovery`, so a string compare gives deterministic order.
  matches.sort((a, b) => {
    if (a.mtime !== b.mtime) return a.mtime - b.mtime;
    return a.subdirPath < b.subdirPath ? -1 : a.subdirPath > b.subdirPath ? 1 : 0;
  });
  const overflow = matches.length - MAX_SNAPSHOTS_PER_BASENAME;
  const toRemove = matches.slice(0, overflow);

  for (const { filePath, subdirPath } of toRemove) {
    try {
      await fs.unlink(filePath);
    } catch {
      continue;
    }
    // If the subdir is now empty (only ever held this one basename),
    // remove it so the recovery folder stays tidy. A populated subdir
    // (other basenames snapshotted in the same second) is left alone.
    try {
      const remaining = await fs.readdir(subdirPath);
      if (remaining.length === 0) await fs.rmdir(subdirPath);
    } catch {
      // Subdir disappeared between readdir and rmdir, or rmdir failed —
      // no remediation needed.
    }
  }
}

/**
 * Walks every timestamp subdir under `.filo/recovery/`, collects every
 * snapshot file, and removes the oldest until the total drops below
 * `MAX_SNAPSHOTS_TOTAL`. Mirrors the per-basename pruner's tiebreak and
 * subdir-cleanup contract: lex-compare timestamp dirs on identical mtimes,
 * rmdir an emptied subdir, swallow per-file fs errors.
 *
 * Runs after `pruneOldSnapshotsForBasename`, so it sees the post-prune state
 * — most well-behaved vaults will short-circuit at the count check below.
 */
async function pruneOldSnapshotsGlobal(vaultRoot: string): Promise<void> {
  const recoveryRoot = join(vaultRoot, RECOVERY_DIR);
  let entries: Array<{ name: string; isDirectory: boolean }>;
  try {
    const dirEntries = await fs.readdir(recoveryRoot, { withFileTypes: true });
    entries = dirEntries.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const allFiles: Array<{ filePath: string; subdirPath: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const subdirPath = join(recoveryRoot, entry.name);
    let subEntries: string[];
    try {
      subEntries = await fs.readdir(subdirPath);
    } catch {
      continue;
    }
    for (const name of subEntries) {
      const filePath = join(subdirPath, name);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        allFiles.push({ filePath, subdirPath, mtime: stat.mtimeMs });
      } catch {
        // Skip — file vanished mid-walk.
      }
    }
  }
  if (allFiles.length <= MAX_SNAPSHOTS_TOTAL) return;

  allFiles.sort((a, b) => {
    if (a.mtime !== b.mtime) return a.mtime - b.mtime;
    return a.subdirPath < b.subdirPath ? -1 : a.subdirPath > b.subdirPath ? 1 : 0;
  });
  const overflow = allFiles.length - MAX_SNAPSHOTS_TOTAL;
  const toRemove = allFiles.slice(0, overflow);

  const touchedSubdirs = new Set<string>();
  for (const { filePath, subdirPath } of toRemove) {
    try {
      await fs.unlink(filePath);
      touchedSubdirs.add(subdirPath);
    } catch {
      continue;
    }
  }
  for (const subdirPath of touchedSubdirs) {
    try {
      const remaining = await fs.readdir(subdirPath);
      if (remaining.length === 0) await fs.rmdir(subdirPath);
    } catch {
      // Same swallow-on-error contract as the per-basename pruner.
    }
  }
}

/** One preserved snapshot, surfaced to the renderer on vault open. */
export interface RecoverySnapshotInfo {
  /** Vault-relative path to the snapshot copy (forward-slashed). */
  relPath: string;
  /**
   * The snapshot's filename as it sits under `<ts>/`: the FLATTENED
   * vault-relative path (`folderA__Notes.md`), or the bare basename for
   * older snapshots.
   */
  basename: string;
  /** The timestamp subdirectory name, ISO-ish: `2026-06-02T14-30-15.123`. */
  timestamp: string;
}

/**
 * Lists the preserved snapshots under `.filo/recovery/` WITHOUT pruning
 * anything. The renderer calls this on vault open so a user whose bytes were
 * preserved during a bad-write window learns the backup exists. Read-only by
 * design: the
 * snapshots are the user's safety net, so they're only removed when the user
 * acts on them (reveal → recover / delete) or the write-time cap trims the
 * oldest — never as an unacknowledged side effect of opening the vault.
 *
 * Returns newest-first; the timestamp dir names sort lexically === chrono.
 * `ENOENT` (no recovery dir) resolves to an empty list — the steady state.
 */
export async function listRecoverySnapshots(vaultRoot: string): Promise<RecoverySnapshotInfo[]> {
  const recoveryRoot = join(vaultRoot, RECOVERY_DIR);
  let entries: Array<{ name: string; isDirectory: boolean }>;
  try {
    const dirEntries = await fs.readdir(recoveryRoot, { withFileTypes: true });
    entries = dirEntries.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: RecoverySnapshotInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const subdirPath = join(recoveryRoot, entry.name);
    let subEntries: string[];
    try {
      subEntries = await fs.readdir(subdirPath);
    } catch {
      continue;
    }
    for (const name of subEntries) {
      // Never list Filo's own sentinels as recoverable user files.
      if (isSentinelSnapshotName(name)) continue;
      try {
        const stat = await fs.stat(join(subdirPath, name));
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      // Forward-slash the vault-relative path (the convention for paths that
      // cross the IPC boundary); `RECOVERY_DIR` uses the OS separator.
      out.push({
        relPath: [RECOVERY_DIR.split(/[\\/]/).join('/'), entry.name, name].join('/'),
        basename: name,
        timestamp: entry.name,
      });
    }
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return out;
}
