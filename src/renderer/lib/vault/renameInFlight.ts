/**
 * Rename-in-flight guard — a counter that is non-zero while an
 * in-app rename / move is mid-flight.
 *
 * Background. `vaultFolderOps.runRename` rebinds `boardStore.paths[boardId]` to
 * the NEW path BEFORE the `vault:rename` IPC moves the file on disk (the rebind
 * must precede the reference cascade so it walks paths that match the intended
 * disk reality). For that window — and the failure-revert window — the cached
 * board path names a file that does not yet (or no longer) exists on disk. A
 * concurrently-armed watcher reconcile (`vault.refreshTreeAndCleanup`) sees the
 * path missing from the freshly-read tree, its `vault:file-exists` probe
 * confirms "missing", and without this guard it would evict the LIVE board
 * mid-rename (tabs closed, pending writes cancelled, cascade flush skipped).
 *
 * The `rename` method brackets its whole sequence (drain + cascade + IPC +
 * revert) in `beginRenameInFlight()` / `endRenameInFlight()`; the reconcile's
 * eviction loop checks `isRenameInFlight()` after its probe and skips evicting
 * while a rename is in flight (the rename queue / next reconcile re-checks once
 * the path settles on disk).
 *
 * A counter, not a boolean, so overlapping renames (a move that delegates to
 * rename, two queued renames) don't clear the guard early.
 *
 * Pure module-scoped state with no imports — cycle-free for any lib/ or store
 * consumer, mirroring `vaultIdentity.ts`.
 */

let renameDepth = 0;

/** Enter a rename — call before the cache rebind, in a try whose finally calls {@link endRenameInFlight}. */
export function beginRenameInFlight(): void {
  renameDepth += 1;
}

/** Leave a rename. Clamped at zero so an unbalanced call can't drive it negative. */
export function endRenameInFlight(): void {
  if (renameDepth > 0) renameDepth -= 1;
}

/** True while any in-app rename / move is mid-flight. */
export function isRenameInFlight(): boolean {
  return renameDepth > 0;
}

/** Test-only — resets the counter so cases don't bleed in-flight state. */
export function __resetRenameInFlightForTests(): void {
  renameDepth = 0;
}
