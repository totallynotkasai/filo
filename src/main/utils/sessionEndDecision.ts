/**
 * Pure decision for the main window's `query-session-end` (Windows is about
 * to shut down, restart or sign out), kept out of `main.ts` so it is
 * unit-testable without a live BrowserWindow, like `windowCloseDecision.ts`.
 *
 * The answer must be given at once, so it rests on the renderer's last report
 * of whether leaving now could lose work (`app:unsaved-state`).
 */

export type SessionRescue = 'idle' | 'running' | 'done';

export interface SessionEndDecision {
  /** Hold the session back (`event.preventDefault()`). */
  preventDefault: boolean;
  /** Ask the renderer to save and keep rescue copies, then exit. */
  startRescue: boolean;
}

export function decideSessionEnd(opts: {
  /** The renderer is running and its window exists. */
  rendererAlive: boolean;
  /** The renderer's last report: leaving now could lose work. */
  mayLoseWork: boolean;
  rescue: SessionRescue;
}): SessionEndDecision {
  // Still saving: keep holding until it replies or its bound runs out.
  if (opts.rescue === 'running') return { preventDefault: true, startRescue: false };
  // Done (Filo is exiting), nothing can answer, or nothing to lose: let it go.
  if (opts.rescue === 'done' || !opts.rendererAlive || !opts.mayLoseWork) return { preventDefault: false, startRescue: false };
  return { preventDefault: true, startRescue: true };
}
