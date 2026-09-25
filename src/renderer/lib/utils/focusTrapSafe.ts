import type { FocusTrap } from 'focus-trap';

/**
 * Deactivate a `focus-trap`, whether or not its container is still in the
 * DOM. Every trap shares focus-trap's global stack, so a trap that is never
 * deactivated stays on it with live document keydown / mousedown / focusin
 * listeners and a detached container: the next Tab or click then throws
 * "must have at least one tabbable node" from that leaked trap. Hosts sit
 * inside `{#if}` blocks and are usually detached by the time teardown runs,
 * so deactivation must never be skipped for that reason.
 *
 * Deactivating can still throw when a trap below this one leaked (unpausing
 * it runs `updateTabbableNodes` on a dead container). Uncaught inside Svelte
 * 5's flush microtask that throw would stall the batch, hence the try/catch.
 * Pass `name` to surface that non-fatal warning in dev logs.
 */
export function safeDeactivateTrap(
  trap: FocusTrap | null | undefined,
  opts?: { name?: string },
): void {
  if (!trap) return;
  try {
    trap.deactivate();
  } catch (err) {
    if (opts?.name) {
      console.warn(`[${opts.name}] focus-trap deactivate failed (non-fatal):`, err);
    }
  }
}
