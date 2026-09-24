/**
 * Session registry of "emergency-preserved" files.
 *
 * When `atomicWriteFile` / `copyFileToVault` hit ENOSPC / EIO / ENOMEM /
 * EACCES *after* the bytes were already staged on disk, they preserve the
 * partial file (rather than deleting it) and annotate the rejected error
 * with `preservedTmpPath` so the user can recover it manually. A transient
 * toast alone isn't enough — during a quit-time flush the window is
 * destroyed before the user can read it.
 *
 * This leaf registry records every such preserved file for the lifetime of
 * the process so `writeQuitFailureBreadcrumb` (run in the quit drain) can
 * persist the locations into `.filo/quit-failure.json`, and the next vault
 * open can surface them (`readQuitFailureBreadcrumb` on the renderer).
 *
 * LEAF MODULE BY DESIGN — it imports nothing from `../vault/*` (only node
 * `path`), so the write primitives (`filenameUtils.atomicWriteFile`,
 * `fileOps.copyFileToVault`) can record into it without a circular import.
 * The breadcrumb WRITE (which needs `atomicWriteFile`) lives in
 * `quitFailureBreadcrumb.ts`.
 */
import { normalize } from 'path';

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

/**
 * Comparison key for an absolute target path. Windows paths are
 * case-insensitive, and the writer call sites can legitimately reach the
 * same destination with differing separators/casing across retries.
 */
function targetKey(p: string): string {
  const norm = normalize(p);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

/**
 * Drops every entry whose `targetPath` matches a destination that has since
 * been written SUCCESSFULLY, so a transient failure followed by a successful
 * retry doesn't leave a breadcrumb pointing at superseded bytes (a phantom
 * "Filo preserved emergency files" notice on the next launch). Called by
 * `atomicWriteFile` / `copyFileToVault` after their rename lands.
 *
 * The preserved `.tmp` itself is deliberately LEFT on disk — deleting it
 * would require proving its bytes match what landed, and a stale recovery
 * file is safer than a deleted one. Never throws (mirror of the recorder).
 */
export function clearPreservedEmergencyFilesForTarget(targetPath: string): void {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return;
  const key = targetKey(targetPath);
  for (let i = session.length - 1; i >= 0; i--) {
    const target = session[i]?.targetPath;
    if (target !== undefined && targetKey(target) === key) session.splice(i, 1);
  }
}

/** Test-only: reset the session registry between cases. */
export function __resetEmergencyFilesForTests(): void {
  session.length = 0;
}
