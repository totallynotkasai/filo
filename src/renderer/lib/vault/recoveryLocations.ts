/**
 * Where the recovery modal points the user: the rescue folders Filo wrote when
 * the vault was left with unsaved work, and the partly written files it moved
 * aside, from the time of the unfinished save on.
 */

/** One `recovery:list` row. */
export interface RecoveryListing {
  relPath: string;
  basename: string;
  timestamp: string;
  kind?: 'snapshot' | 'unsaved' | 'keep' | 'orphan-tmp';
}

export interface RecoveryLocation {
  kind: 'unsaved' | 'orphan-tmp';
  /** When the folder was written (ms), from its name. */
  at: number;
  /** A file in it, vault-relative: "Show in folder" selects it. */
  firstFile: string;
  files: number;
}

/** A recovery folder name's time: ISO with `:` written as `-`, UTC, optional `-unsaved` / `-keep`. */
export function recoveryStampTime(stamp: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?/.exec(stamp);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5] ?? ''}Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Rescue and moved-aside folders written at or after `since` (the unfinished
 * save's time; a little slack for clocks), newest first, one row per folder.
 */
export function recoveryLocationsSince(listing: readonly RecoveryListing[], since: number | undefined): RecoveryLocation[] {
  const floor = since === undefined ? Number.NEGATIVE_INFINITY : since - 60_000;
  const byFolder = new Map<string, RecoveryLocation>();
  for (const row of listing) {
    if (row.kind !== 'unsaved' && row.kind !== 'orphan-tmp') continue;
    const at = recoveryStampTime(row.timestamp);
    if (at === null || at < floor) continue;
    const folder = row.relPath.slice(0, row.relPath.length - row.basename.length);
    const seen = byFolder.get(folder);
    if (seen) seen.files += 1;
    else byFolder.set(folder, { kind: row.kind, at, firstFile: row.relPath, files: 1 });
  }
  return [...byFolder.values()].sort((a, b) => b.at - a.at);
}
