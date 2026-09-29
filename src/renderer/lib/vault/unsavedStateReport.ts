/**
 * Keeps main told whether leaving now could lose work, so that when Windows
 * asks to end the session main can answer at once: hold it back while Filo
 * saves and keeps rescue copies, or let it go (`main/services/sessionEnd.ts`).
 *
 * "Could lose work" is generous on purpose: anything unsaved, a change held
 * for the user's answer, unapplied Settings, or a focused text field (its
 * text may not be in any writer yet). Holding a shutdown back for a second
 * with nothing to save costs little; letting one go with work in memory
 * loses it.
 */
import { isEditableTextTarget } from '../utils/editableTarget';

export interface UnsavedStateSources {
  nothingUnsaved: () => boolean;
  heldDecisionCount: () => number;
  openSettingsEdits: () => boolean;
}

export function mayLoseWorkNow(sources: UnsavedStateSources): boolean {
  try {
    return (
      !sources.nothingUnsaved() ||
      sources.heldDecisionCount() > 0 ||
      sources.openSettingsEdits() ||
      isEditableTextTarget(document.activeElement)
    );
  } catch {
    // Can't tell: say yes, so a shutdown waits for the save.
    return true;
  }
}

/** How often the answer is checked between the events that change it. */
export const UNSAVED_STATE_POLL_MS = 1000;

/**
 * Sends `send(flag)` now and whenever the answer changes: checked on focus
 * moves, on `nudge()` (write-state changes), and every
 * {@link UNSAVED_STATE_POLL_MS} (Settings edits have no event). Returns the
 * stop function and the nudge.
 */
export function startUnsavedStateReport(
  sources: UnsavedStateSources,
  send: (mayLoseWork: boolean) => void,
): { stop: () => void; nudge: () => void } {
  let last: boolean | null = null;
  const check = (): void => {
    const next = mayLoseWorkNow(sources);
    if (next === last) return;
    last = next;
    try {
      send(next);
    } catch (err) {
      console.error('[unsavedStateReport] telling main failed:', err);
    }
  };
  // Focus leaves a field before the next one takes it: check once both are done.
  const onFocusChange = (): void => queueMicrotask(check);
  document.addEventListener('focusin', onFocusChange);
  document.addEventListener('focusout', onFocusChange);
  const timer = setInterval(check, UNSAVED_STATE_POLL_MS);
  check();
  return {
    stop: () => {
      clearInterval(timer);
      document.removeEventListener('focusin', onFocusChange);
      document.removeEventListener('focusout', onFocusChange);
    },
    nudge: check,
  };
}
