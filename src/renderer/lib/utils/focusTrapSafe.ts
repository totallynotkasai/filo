import type { FocusTrap } from 'focus-trap';

/**
 * Safely deactivate a `focus-trap`. The library throws from
 * `updateTabbableNodes` when its host element has been unmounted before the
 * teardown runs — uncaught inside Svelte 5's flush microtask, that throw
 * corrupts the batch processor and freezes the app. Wrapping every call
 * site in try/catch is repetitive; this helper centralises it.
 *
 * Pass `host` when the caller wants to skip deactivation entirely if the
 * host element is already detached (e.g. Modal.svelte's dialog element).
 * Pass `name` to surface the non-fatal warning in dev logs.
 */
export function safeDeactivateTrap(
  trap: FocusTrap | null | undefined,
  opts?: { host?: Element | null; name?: string },
): void {
  if (!trap) return;
  if (opts?.host && !opts.host.isConnected) return;
  try {
    trap.deactivate();
  } catch (err) {
    if (opts?.name) {
      console.warn(`[${opts.name}] focus-trap deactivate failed (non-fatal):`, err);
    }
  }
}
