import { invokeOk } from '../utils/invokeOk';
import { markPathFailed } from '../boards/writeStateTracking';
import { getBaseline, hasBaselineDrifted } from './fileBaselineRegistry';
import { getExternalEditPromptHandler } from './externalEditPrompt';
import { backupExternalVersion } from './keepLocalBackup';

/**
 * Phase R6 / 6.4.M13 / Audit-16 5.2 — the markdown gateway's PRE-WRITE drift
 * gate, extracted from `markdownFileWriter.writeMarkdownFileImpl` (the
 * file-size split queued since the M13 loop landed).
 *
 * If the file's stat on disk differs from the baseline captured at hydrate
 * time (or after the most recent self-write), an external editor wrote to the
 * file since we last knew about it. Surface the Reload / Keep-local prompt so
 * the user explicitly chooses whether to clobber the external bytes — never
 * silently overwrite. No baseline → no comparison anchor → proceed (the legacy
 * unguarded path, e.g. the first write to a freshly-seeded file).
 *
 * Outcomes:
 *  - `{ action: 'drop' }` — the user chose Reload; the caller must DISCARD the
 *    scheduled write (the Reload handler already refreshed the index + editor
 *    and re-stamped the baseline).
 *  - `{ action: 'proceed', verifyStat }` — the write may continue.
 *  - throws — 'defer' (prompt dismissed) or the re-prompt budget was exhausted
 *    against a churning external writer. Audit-6 M1: a bare return here once
 *    resolved performWrite as SUCCESS → `safeEndWrite(true)` → `.filo/.dirty`
 *    markClean'd while the dirty edit never reached disk → quit lost the edit
 *    with a CLEAN sentinel. `markPathFailed` + throw keeps the sentinel dirty,
 *    shows the error indicator, and attributes the path to `flushAll().failed`.
 */
export interface DriftGateOutcome {
  action: 'proceed' | 'drop';
  /**
   * 5.2 (Audit-16) — the last disk stat the drift decision TRUSTED: the
   * pre-write stat, or the post-prompt re-stat the user approved. The delta
   * branch re-stats after its in-chain read and verifies against this anchor,
   * so an external write landing in the stat→read gap — invisible to the
   * drift check, and a torn/stale read of it would be written back verbatim
   * as the delta body — aborts loudly instead. Undefined ⇒ no anchor (no
   * baseline, stat failure, or the legacy proceed-on-failed-re-stat path) —
   * the verify is skipped, the pre-5.2 trust level.
   */
  verifyStat?: { mtimeMs: number; size: number };
}

export async function runPreWriteDriftGate(
  vaultRoot: string,
  relPath: string,
): Promise<DriftGateOutcome> {
  const baseline = getBaseline(relPath);
  if (baseline === undefined) return { action: 'proceed' };

  let preWriteStat: { mtimeMs: number; size: number } | undefined;
  try {
    preWriteStat = await invokeOk('vault:stat', vaultRoot, relPath);
  } catch {
    // Stat failed (ENOENT, EACCES, NO_ACTIVE_VAULT). Proceed — the write IPC
    // surfaces the same shape via trackComponentWrite.
  }
  if (preWriteStat === undefined || !hasBaselineDrifted(baseline, preWriteStat)) {
    return { action: 'proceed', verifyStat: preWriteStat };
  }

  // 6.4.M13 — the Reload / Keep-local prompt is async, so the file can drift
  // AGAIN while the modal is open. After each 'keep-local', re-stat: if the
  // bytes the user agreed to overwrite changed since they were shown the
  // prompt, re-prompt so an external edit the user never saw is never silently
  // clobbered. Bounded to avoid a livelock against a rapid external writer; on
  // exhaustion, abort (the next debounced write re-detects and re-prompts).
  const handler = getExternalEditPromptHandler();
  const MAX_DRIFT_REPROMPTS = 3;
  let shownStat = preWriteStat;
  for (let attempt = 0; attempt < MAX_DRIFT_REPROMPTS; attempt++) {
    const choice = handler ? await handler(relPath) : 'keep-local';
    if (choice === 'reload') {
      // The Reload handler refreshed the vault index + editor content from
      // disk and re-stamped the drift baseline (applyReloadFromDisk →
      // noteBaseline, threaded from the read). Drop this scheduled write —
      // the user explicitly chose to discard their pending bytes.
      return { action: 'drop' };
    }
    if (choice === 'defer') {
      // 6.4.M4 — dismissed without choosing (auto-dismiss or manual close).
      // Neither side was touched; abort so the external edit on disk survives,
      // and let the dirty in-memory state persist so the next debounced write
      // re-prompts. No baseline refresh. Loud per Audit-6 M1 (docstring).
      markPathFailed(vaultRoot, relPath);
      throw new Error(
        `markdownFileWriter: write to "${relPath}" deferred — external edit on disk unresolved; not overwritten`,
      );
    }
    // 'keep-local' — the user chose to overwrite. Confirm nothing drifted
    // while the modal was open before committing the clobber.
    let recheckStat: { mtimeMs: number; size: number } | undefined;
    try {
      recheckStat = await invokeOk('vault:stat', vaultRoot, relPath);
    } catch {
      // Re-stat failed — can't confirm a second drift. Proceed with the
      // overwrite as the pre-M13 code did; the write IPC surfaces any genuine
      // IO error through the failure-attribution pipeline.
      recheckStat = undefined;
    }
    if (
      recheckStat === undefined ||
      (recheckStat.mtimeMs === shownStat.mtimeMs && recheckStat.size === shownStat.size)
    ) {
      // Audit-19 UX-6 — the external bytes go to .filo/recovery/ before the
      // clobber. A failed backup the user declined to overwrite without →
      // defer (loud, same as a dismissed prompt).
      if (!(await backupExternalVersion(vaultRoot, relPath))) {
        markPathFailed(vaultRoot, relPath);
        throw new Error(
          `markdownFileWriter: write to "${relPath}" deferred — the external version could not be backed up; not overwritten`,
        );
      }
      // 5.2 — the approval re-anchors the verify stat: the user agreed to
      // overwrite the bytes recheckStat observed. A failed re-stat keeps the
      // legacy proceed-without-confirmation decision — no anchor.
      return { action: 'proceed', verifyStat: recheckStat };
    }
    // The file drifted again during the prompt — loop to re-prompt against
    // the freshly-observed state rather than overwrite bytes never shown.
    shownStat = recheckStat;
  }

  // Re-prompt budget exhausted against a churning external writer. Abort
  // rather than clobber an unseen edit (loud per Audit-6 M1 — see docstring).
  markPathFailed(vaultRoot, relPath);
  throw new Error(
    `markdownFileWriter: write to "${relPath}" aborted — external edit kept churning across drift re-prompts; not overwritten`,
  );
}
