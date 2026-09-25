import { vaultPath, type VaultPath } from '../../../shared/vaultPath';

/**
 * External-change timing/bookkeeping windows — split out of
 * `stores/vaultExternalChanges.ts` (file-size ceiling).
 *
 * This module owns the module-scoped windows the external-change pipeline
 * consults to avoid acting on transient watcher noise:
 *
 *   - Attachment-delete grace window — records the most recent external
 *     rename per oldPath so the deferred attachment-delete prompt can
 *     suppress a spurious "deleted externally" toast for a cross-folder
 *     move the rename correlator hasn't paired yet.
 *   - Expected reappearance — a sync-conflict original about to come back.
 *
 * (A note read caught mid-write is retried by the note store itself.)
 *
 * Self-contained: depends only on the `VaultPath` brand from
 * `shared/vaultPath`. It has NO imports from `stores/` or `components/`.
 *
 * Reset semantics: `vaultExternalChanges.ts` keeps the
 * `onVaultSwap('pre-swap', 'vaultExternalChanges', …)` registration (the
 * characterization test asserts that subscriber name exists) and calls
 * `clearRecentRenames()` from inside it.
 * These maps are declared `const`, so the `gates:vault-scoped-state` gate (which
 * only flags `let`-declared module state) does not require a second swap
 * subscription here.
 */

// ---------------------------------------------------------------------------
// Attachment-delete grace window
// ---------------------------------------------------------------------------

/**
 * Grace window (ms) for the deferred attachment-delete prompt. Tracks
 * the most recently observed `vault:file-renamed` event for each oldPath.
 * When `handleExternalAttachmentChanges` would otherwise prompt for a
 * deleted file, it first sleeps `ATTACHMENT_DELETE_GRACE_MS` and re-checks
 * whether a rename for the same path landed in the interim. If yes, the
 * cross-folder external move (which the watcher reports as a deleted-old +
 * created-new pair before the correlator pairs them) gets suppressed
 * instead of surfacing a spurious "deleted externally" toast.
 *
 * 500 ms covers the typical correlator latency (debounce + a single tick
 * for the synthetic-rename emit) without delaying the genuine delete case
 * meaningfully — a delete the user actually intends is also still "5+
 * seconds ago by the time they're looking at the toast".
 */
export const ATTACHMENT_DELETE_GRACE_MS = 500;

/**
 * How long a note with a change that isn't on disk yet may look deleted
 * before the user is asked about it. A rename by another program reaches the
 * app as its own event, after the watcher's debounce (up to 1 s) and its hold
 * for an unpaired missing note (`MISSING_NOTE_HOLD_MS`, 1.5 s, main process).
 * Meanwhile the note's write can fail on the old path or its "missing" event
 * can arrive first; once the rename re-keys the note there is nothing to ask.
 */
export const NOTE_RENAME_GRACE_MS = 3000;
// allow-module-state: reset via clearRecentRenames called from vaultExternalChanges's pre-swap handler
const recentRenamedOldPaths = new Map<VaultPath, number>();

export function noteRecentRename(oldRel: string): void {
  recentRenamedOldPaths.set(vaultPath(oldRel), Date.now());
  // Bound the map size by pruning entries older than 2× grace. We don't
  // need stale entries lingering past the window — the consumer only
  // looks back ATTACHMENT_DELETE_GRACE_MS.
  const horizon = Date.now() - ATTACHMENT_DELETE_GRACE_MS * 2;
  for (const [path, ts] of recentRenamedOldPaths) {
    if (ts < horizon) recentRenamedOldPaths.delete(path);
  }
}

export function wasRecentlyRenamed(oldRel: string): boolean {
  const ts = recentRenamedOldPaths.get(vaultPath(oldRel));
  if (ts === undefined) return false;
  return Date.now() - ts < ATTACHMENT_DELETE_GRACE_MS;
}

/**
 * Clears the recent-rename grace map. Called from the external-changes
 * store's `onVaultSwap` handler so a same-named file in the new vault isn't
 * suppressed by a stale entry from the prior vault.
 */
export function clearRecentRenames(): void {
  recentRenamedOldPaths.clear();
  expectedReappearance.clear();
}

/**
 * A sync conflict (OneDrive renames the local copy to
 * `Note-DEVICE.md`, then downloads the other version as `Note.md`) leaves the
 * canonical path missing for a moment. For that window its "deleted
 * externally" prompt is deferred — the file is expected to reappear.
 */
// allow-module-state: reset via clearRecentRenames (vault swap) — deadline-bounded anyway
const expectedReappearance = new Map<VaultPath, number>(); // allow-no-rename-transfer: short deadline keyed by the path that is about to reappear

export function noteExpectedReappearance(rel: string, ms: number): void {
  expectedReappearance.set(vaultPath(rel), Date.now() + ms);
}

/** Remaining ms of the reappearance window for `rel` (0 when none). */
export function reappearanceWindowRemaining(rel: string): number {
  const deadline = expectedReappearance.get(vaultPath(rel));
  if (deadline === undefined) return 0;
  const left = deadline - Date.now();
  if (left <= 0) expectedReappearance.delete(vaultPath(rel));
  return Math.max(0, left);
}

/**
 * Test seam for the grace-window timer. Allows unit tests to drain
 * the recent-rename map deterministically without depending on real
 * `Date.now()` progression.
 */
export function _resetAttachmentDeleteGraceForTests(): void {
  recentRenamedOldPaths.clear();
  expectedReappearance.clear();
}
