/**
 * 6.2.H4 (follow-up) — session registry of "emergency-preserved" files.
 *
 * When `atomicWriteFile` / `copyFileToVault` hit ENOSPC / EIO / ENOMEM /
 * EACCES *after* the bytes were already staged on disk, they preserve the
 * partial file (rather than deleting it) and annotate the rejected error
 * with `preservedTmpPath` so the user can recover it manually. Pre-fix that
 * location only ever reached the user as a transient toast — and if it
 * landed during a quit-time flush, the window destroyed before they could
 * read it (the original 6.2.H4 finding).
 *
 * This leaf registry records every such preserved file for the lifetime of
 * the process so `writeQuitFailureBreadcrumb` (run in the quit drain) can
 * persist the locations into `.filo/quit-failure.json`, and the next vault
 * open can surface them (`readQuitFailureBreadcrumb` on the renderer).
 *
 * LEAF MODULE BY DESIGN — it imports nothing from `../vault/*`, so the write
 * primitives (`filenameUtils.atomicWriteFile`, `fileOps.copyFileToVault`) can
 * record into it without a circular import. The breadcrumb WRITE (which needs
 * `atomicWriteFile`) lives in `quitFailureBreadcrumb.ts`.
 */
export interface PreservedEmergencyFile {
  /** Absolute path where the partial bytes were preserved on disk. */
  preservedPath: string;
  /** The intended destination the write was targeting, if known. */
  targetPath?: string;
  /** The errno code that triggered preservation (ENOSPC / EIO / …). */
  code?: string;
  /** Epoch ms when the file was preserved. */
  at: number;
}

const session: PreservedEmergencyFile[] = [];

/**
 * Records a preserved emergency file. De-dupes by `preservedPath` — a retried
 * write against the same destination can preserve the same partial twice; the
 * first sighting wins. Never throws (called from inside an error path).
 */
export function recordPreservedEmergencyFile(entry: {
  preservedPath: string;
  targetPath?: string;
  code?: string;
}): void {
  if (!entry || typeof entry.preservedPath !== 'string' || entry.preservedPath.length === 0) {
    return;
  }
  if (session.some((e) => e.preservedPath === entry.preservedPath)) return;
  session.push({
    preservedPath: entry.preservedPath,
    targetPath: entry.targetPath,
    code: entry.code,
    at: Date.now(),
  });
}

/** Snapshot of every preserved emergency file recorded this session. */
export function listPreservedEmergencyFiles(): readonly PreservedEmergencyFile[] {
  return session;
}

/** Test-only: reset the session registry between cases. */
export function __resetEmergencyFilesForTests(): void {
  session.length = 0;
}
