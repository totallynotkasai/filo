import { vaultPath, type VaultPath } from '../../../shared/vaultPath';

/**
 * External-change timing/bookkeeping windows — split out of
 * `stores/vaultExternalChanges.ts` (file-size ceiling).
 *
 * This module owns the two module-scoped grace/retry windows the external-
 * change pipeline consults to avoid acting on its own in-flight writes and
 * transient watcher noise:
 *
 *   1. Partial-read retry bookkeeping — bounds the re-classify loop for a
 *      file the watcher reported mid-write (a truncated read). Tracks the
 *      in-flight Set, the per-path attempt counter, and the scheduled
 *      `setTimeout` handles so a vault swap can cancel them before they fire
 *      against the new vault.
 *   2. Attachment-delete grace window — records the most recent external
 *      rename per oldPath so the deferred attachment-delete prompt can
 *      suppress a spurious "deleted externally" toast for a cross-folder
 *      move the rename correlator hasn't paired yet.
 *
 * Self-contained: depends only on the `VaultPath` brand from
 * `shared/vaultPath`. It has NO imports from `stores/` or `components/`.
 *
 * Reset semantics: `vaultExternalChanges.ts` keeps the
 * `onVaultSwap('pre-swap', 'vaultExternalChanges', …)` registration (the
 * characterization test asserts that subscriber name exists) and calls
 * `resetPartialReadRetryInflight()` + `clearRecentRenames()` from inside it.
 * These maps are declared `const`, so the `gates:vault-scoped-state` gate (which
 * only flags `let`-declared module state) does not require a second swap
 * subscription here.
 */

// ---------------------------------------------------------------------------
// Partial-read retry bookkeeping
// ---------------------------------------------------------------------------

/**
 * Paths currently inside a partial-read retry window. Prevents an infinite
 * re-classify loop when an external write stays mid-flight across the retry
 * interval. A path is removed once its delayed re-read fires.
 *
 * Bounded backoff (500 / 1500 / 3000 ms, max 3 attempts) so a
 * perpetually-mid-write file can't loop forever. After exhaustion we surface
 * a "file shrank externally — reload or keep your view?" toast.
 */
export const PARTIAL_READ_RETRY_BACKOFF_MS = [500, 1500, 3000] as const;
export const PARTIAL_READ_MAX_RETRIES = PARTIAL_READ_RETRY_BACKOFF_MS.length;
// allow-module-state: reset via resetPartialReadRetryInflight called from vaultExternalChanges's pre-swap handler
const partialReadRetryInflight = new Set<VaultPath>();
/**
 * Per-path retry counter. Incremented on each scheduled retry; cleared on
 * successful re-classification (the next pass returns sync-frontmatter /
 * reload-silently / ignore) or after the user dismisses the exhaustion
 * toast.
 */
// allow-module-state: reset via resetPartialReadRetryInflight called from vaultExternalChanges's pre-swap handler
const partialReadRetryCount = new Map<VaultPath, number>();

/**
 * Tracks the scheduled retry `setTimeout` handles so a vault swap can
 * `clearTimeout` them. Otherwise a late timer would re-classify a same-named
 * file in the new vault against the old vault's baseline — a silent
 * misclassification that could overwrite content.
 */
// allow-module-state: reset via resetPartialReadRetryInflight called from vaultExternalChanges's pre-swap handler
const partialReadRetryTimers = new Map<VaultPath, ReturnType<typeof setTimeout>>();

/** True while a partial-read retry is already scheduled for `key`. */
export function isPartialReadRetryInflight(key: VaultPath): boolean {
  return partialReadRetryInflight.has(key);
}

/** Current retry attempt count for `key` (0 if none scheduled yet). */
export function getPartialReadRetryCount(key: VaultPath): number {
  return partialReadRetryCount.get(key) ?? 0;
}

/**
 * Drop the retry budget for `key`. Called when a non-retry classification
 * means the mid-write window closed (the file's body matches the index
 * baseline, the file is now clean+equivalent, etc.) so a future transient
 * shrink starts fresh.
 */
export function clearPartialReadRetryCount(key: VaultPath): void {
  partialReadRetryCount.delete(key);
}

/**
 * Schedule a bounded partial-read retry for `key`. Marks the path in-flight,
 * bumps its attempt counter, and arms a `setTimeout` (whose handle is tracked
 * for vault-swap cancellation). When the timer fires it clears its own
 * tracking entries before invoking `run`.
 *
 * Returns `false` when a retry is already in-flight for `key` (caller skips).
 */
export function schedulePartialReadRetry(
  key: VaultPath,
  attempt: number,
  run: () => void,
): boolean {
  if (partialReadRetryInflight.has(key)) return false;
  partialReadRetryInflight.add(key);
  partialReadRetryCount.set(key, attempt + 1);
  const delay = PARTIAL_READ_RETRY_BACKOFF_MS[attempt];
  // Record the timer handle so vault-swap reset can
  // clearTimeout before it fires. The callback also clears its
  // own entry on dispatch so the map stays bounded.
  const timer = setTimeout(() => {
    partialReadRetryTimers.delete(key);
    partialReadRetryInflight.delete(key);
    run();
  }, delay);
  partialReadRetryTimers.set(key, timer);
  return true;
}

/**
 * Clears the partial-read retry state on vault swap (called from the
 * external-changes store's `onVaultSwap` handler): the in-flight Set (else a
 * same-named file in the new vault is wrongly deduped), the per-path counter
 * (else an outgoing-vault exhaustion toast surfaces in the new vault), and
 * every pending timer (else it re-enters the classifier against the new vault).
 */
export function resetPartialReadRetryInflight(): void {
  for (const timer of partialReadRetryTimers.values()) clearTimeout(timer);
  partialReadRetryTimers.clear();
  partialReadRetryInflight.clear();
  partialReadRetryCount.clear();
}

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
