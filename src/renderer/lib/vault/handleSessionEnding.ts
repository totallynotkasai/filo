/**
 * Windows is ending the session (shutdown, restart, sign-out) and main is
 * holding it back for a few seconds (see `main/services/sessionEnd.ts`).
 *
 * There is no dialog: the user is leaving. Filo saves what it can (a focused
 * field hands its text over first), then keeps a rescue copy in
 * `.filo/recovery/<ts>-unsaved/` of anything still unsaved: a write kept for
 * Retry, a change held for an unanswered question, and unapplied Settings or
 * theme-editor edits (as `_filo__*.json`). The crash sentinel keeps naming
 * whatever isn't on disk, so the next open offers recovery. Then main is told
 * it may go, even if a step failed or ran out of time.
 *
 * `mayLoseWork` is what the renderer keeps telling main (`app:unsaved-state`):
 * main must answer Windows at once, so it can't ask.
 */
import type { RescueResult } from './unsavedMessages';

export interface SessionEndingDeps {
  /** Saves everything, as leaving the vault does. Production wires `saveUntilSettled(() => vaultStore.save())`. */
  save: () => Promise<boolean>;
  /**
   * Freezes the editors while the save and the copies run. Released when
   * done: main exits right after, and if the session doesn't end after all,
   * Filo stays usable.
   */
  freeze?: () => () => void;
  /** Nothing pending, failed, in flight or unserialised. Production wires `isUnsavedWorkEmpty(unsavedWork())`. */
  nothingUnsaved: () => boolean;
  /** How many changes wait for the user's answer. */
  heldDecisionCount: () => number;
  /** The theme editor or a Settings tab holds unapplied edits. */
  openSettingsEdits: () => boolean;
  /** Rescue copies of what is left, unapplied Settings included when asked. */
  keepRescueCopies: (opts: { unappliedSettings: boolean }) => Promise<RescueResult>;
  /** Lets the sentinel's queued write reach disk. */
  flushSentinel?: () => Promise<void>;
  send: (channel: 'app:session-ending-done') => void;
  reportError: (context: string, err: unknown, msg: string) => void;
}

/** Budget for the save, and separately for the rescue copies: main holds Windows for about 4 s. */
export const SESSION_SAVE_BOUND_MS = 2500;
export const SESSION_RESCUE_BOUND_MS = 1200;
const SESSION_SENTINEL_BOUND_MS = 300;

// allow-module-state: a re-entrancy guard for one process-wide event, reset in finally
let running = false;

/** `op`, or nothing once `ms` have passed; its failure is reported, not thrown. */
async function bounded<T>(op: () => Promise<T>, ms: number, deps: SessionEndingDeps, what: string): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } catch (err) {
    deps.reportError('App', err, `${what} failed while Windows was ending the session`);
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function handleSessionEnding(deps: SessionEndingDeps): Promise<void> {
  if (running) return;
  running = true;
  const thaw = deps.freeze?.();
  try {
    await bounded(deps.save, SESSION_SAVE_BOUND_MS, deps, 'Saving');
    const unappliedSettings = deps.openSettingsEdits();
    if (!deps.nothingUnsaved() || deps.heldDecisionCount() > 0 || unappliedSettings) {
      await bounded(() => deps.keepRescueCopies({ unappliedSettings }), SESSION_RESCUE_BOUND_MS, deps, 'Keeping copies of unsaved changes');
    }
    if (deps.flushSentinel) await bounded(deps.flushSentinel, SESSION_SENTINEL_BOUND_MS, deps, 'Recording unsaved files');
  } finally {
    running = false;
    thaw?.();
    deps.send('app:session-ending-done');
  }
}

/** Test-only — clears the re-entrancy guard between cases. */
export function __resetSessionEndingForTests(): void {
  running = false;
}
