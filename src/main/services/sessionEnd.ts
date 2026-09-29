/**
 * sessionEnd — Windows ending the session (shutdown, restart, sign-out) while
 * Filo is open.
 *
 * Windows doesn't close the window or quit the app first, so neither the
 * window `close` drain nor `before-quit` runs. A forced restart (an update,
 * the power button) could then drop a change still in memory: a focused
 * field, an unanswered conflict or drift question, unapplied Settings, a
 * write kept for Retry.
 *
 * `query-session-end` must be answered at once, so the renderer keeps main
 * told whether leaving now could lose work (`app:unsaved-state`). Only then
 * is the session held back (Windows shows its "Filo is preventing shutdown"
 * screen) while the renderer saves and keeps rescue copies, with no dialog;
 * its reply (`app:session-ending-done`, or the bound running out) ends it:
 * main tears down and exits, and Windows goes on. `session-end` can't be
 * delayed: the renderer is asked all the same, and the breadcrumb written.
 */

import { decideSessionEnd, type SessionRescue } from '../utils/sessionEndDecision';

/** How long the session is held for the renderer's save and rescue copies. */
export const SESSION_RESCUE_BOUND_MS = 4000;

export interface SessionEndDeps {
  rendererAlive(): boolean;
  /** Sends `app:session-ending` to the renderer. Throws when it can't. */
  sendSessionEnding(): void;
  /** Listens once for `app:session-ending-done`; returns the unregister. */
  onceDone(listener: () => void): () => void;
  /** Marks a quit in progress, so a window close meanwhile starts no drain. */
  markQuitting(): void;
  /** Main-side teardown before exiting (geometry, watcher, breadcrumb); bounded by the caller. */
  teardown(): Promise<unknown>;
  /** Bounded wait on `teardown`. */
  teardownBoundMs: number;
  /** Ends the process (`app.exit(0)`). */
  exit(): void;
  /** Writes the quit-failure breadcrumb (no-op unless a write preserved a partial). */
  writeBreadcrumb(): Promise<unknown>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionEndHandlers {
  /** The renderer's `app:unsaved-state` push. */
  noteUnsavedState(mayLoseWork: boolean): void;
  /** `query-session-end`. True when the caller must `preventDefault()`. */
  onQuerySessionEnd(): boolean;
  /** `session-end`: no delay possible. */
  onSessionEnd(): void;
  /** For tests. */
  state(): SessionRescue;
}

export function createSessionEndHandlers(deps: SessionEndDeps): SessionEndHandlers {
  let mayLoseWork = false;
  let rescue: SessionRescue = 'idle';

  function finish(): void {
    if (rescue !== 'running') return;
    rescue = 'done';
    const bound = new Promise<void>((resolve) => deps.setTimeout(resolve, deps.teardownBoundMs));
    void Promise.race([deps.teardown().catch(() => undefined), bound]).finally(() => deps.exit());
  }

  function startRescue(): void {
    rescue = 'running';
    deps.markQuitting();
    let unregister: () => void = () => {};
    const timer = deps.setTimeout(() => {
      unregister();
      finish();
    }, SESSION_RESCUE_BOUND_MS);
    unregister = deps.onceDone(() => {
      deps.clearTimeout(timer);
      finish();
    });
    try {
      deps.sendSessionEnding();
    } catch {
      deps.clearTimeout(timer);
      unregister();
      finish();
    }
  }

  return {
    noteUnsavedState(next: boolean): void {
      mayLoseWork = next;
    },
    onQuerySessionEnd(): boolean {
      const decision = decideSessionEnd({ rendererAlive: deps.rendererAlive(), mayLoseWork, rescue });
      if (decision.startRescue) startRescue();
      return decision.preventDefault;
    },
    onSessionEnd(): void {
      if (rescue === 'idle' && deps.rendererAlive()) {
        // Fire and forget: whatever the renderer saves before the process
        // is ended is saved; the dirty sentinel names the rest.
        try {
          deps.sendSessionEnding();
        } catch {
          // Nothing more can be done here.
        }
      }
      void deps.writeBreadcrumb().catch(() => undefined);
    },
    state: () => rescue,
  };
}
