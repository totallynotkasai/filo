import { onVaultSwap } from '../../core/vaultLifecycle';

/**
 * Sprint C / C.1 — per-instance dirty tracker for open Properties popups.
 *
 * Backs the `propertiesPopupDirty` gate in `classifyExternalChange`. When a
 * Properties popup has unflushed row edits for path X, an external
 * frontmatter-only edit to X must surface a Reload/Keep-local toast
 * instead of silently overwriting the popup's pending state via the
 * `sync-frontmatter` short-circuit.
 *
 * Keyed by the popup's gateway `callerId` (its `flusherId`) so multiple
 * popups open against the same vault file (e.g. split-pane tiles backing
 * the same `.md`) tracked independently — clearing one doesn't drop the
 * other's dirty state.
 *
 * Reset on `pre-swap` so a same-named file in the next vault doesn't
 * inherit a stale bit from the outgoing vault.
 */

const dirtyPathByInstance = new Map<string, string>();

/**
 * Mark popup instance `callerId` as dirty against `relPath`. Idempotent —
 * re-call on every row mutation; the latest path wins (handles a popup
 * whose underlying tile path was renamed mid-edit).
 *
 * Empty `callerId` or `relPath` are silently ignored — neither identifies
 * a tracked popup, so there's nothing to record.
 */
export function markPropertiesPopupDirty(callerId: string, relPath: string): void {
  if (!callerId || !relPath) return;
  dirtyPathByInstance.set(callerId, relPath);
}

/**
 * Drop the dirty bit for popup instance `callerId`. Called from the
 * popup's onDestroy and from its flush-success path (so a clean popup
 * left open after a successful flush stops blocking the
 * `sync-frontmatter` short-circuit for its path).
 */
export function clearPropertiesPopupDirty(callerId: string): void {
  if (!callerId) return;
  dirtyPathByInstance.delete(callerId);
}

/**
 * True iff any registered popup instance currently maps to `relPath`.
 * The classifier consults this once per external-change classification
 * to decide whether to convert the frontmatter-only short-circuit to
 * a `prompt-user` toast.
 */
export function isPropertiesPopupDirty(relPath: string): boolean {
  if (!relPath) return false;
  for (const p of dirtyPathByInstance.values()) {
    if (p === relPath) return true;
  }
  return false;
}

/**
 * Returns every callerId currently dirty against `relPath`. The Reload
 * handler in the external-edit toast iterates these to cancel pending
 * gateway writes so the user's discarded popup edits don't land on disk
 * after they explicitly picked Reload.
 */
export function getDirtyInstancesForPath(relPath: string): string[] {
  if (!relPath) return [];
  const out: string[] = [];
  for (const [callerId, path] of dirtyPathByInstance) {
    if (path === relPath) out.push(callerId);
  }
  return out;
}

/**
 * Test-only — drops every tracked instance. Production code uses
 * `clearPropertiesPopupDirty` (per-instance) or the vault-swap hook
 * (full reset).
 */
export function __resetPropertiesPopupTrackerForTests(): void {
  dirtyPathByInstance.clear();
}

onVaultSwap('pre-swap', 'propertiesPopupTracker', () => {
  dirtyPathByInstance.clear();
});
