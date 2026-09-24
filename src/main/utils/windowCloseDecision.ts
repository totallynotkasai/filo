/**
 * Pure decision for the main window's `close` handler, kept out of `main.ts`
 * so the re-entrancy guard is unit-testable without a live BrowserWindow.
 *
 * The window stays interactive during a flush-and-quit drain, which can be slow
 * on a contended / OneDrive volume. A SECOND X-click during the drain must still
 * call `event.preventDefault()`, or Electron destroys the window and aborts the
 * in-flight write drain, losing the unflushed bytes.
 *
 * The guard branch must keep blocking the close (preventDefault) until the drain
 * itself destroys the window via `mainWindow.destroy()` — which does not refire
 * `close`, so this guard never blocks the legitimate teardown.
 */

export interface WindowCloseDecision {
  /** Call `event.preventDefault()` to keep the window alive. */
  preventDefault: boolean;
  /** Begin a fresh flush-and-quit drain (only on the first close). */
  startDrain: boolean;
}

export function decideWindowClose(opts: {
  /** A flush-and-quit drain is already in progress. */
  isFlushing: boolean;
  /** The window still exists and its webContents isn't destroyed. */
  windowAlive: boolean;
}): WindowCloseDecision {
  // A drain is already running — keep blocking every further close so a second
  // X-click can't destroy the window mid-write. Don't start another drain.
  if (opts.isFlushing) return { preventDefault: true, startDrain: false };
  // The window is already gone (e.g. destroyed by the drain timeout) — there's
  // nothing to block or drain; let the close proceed.
  if (!opts.windowAlive) return { preventDefault: false, startDrain: false };
  // First close — block the destroy and start the drain.
  return { preventDefault: true, startDrain: true };
}
