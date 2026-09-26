/**
 * Changes held for the user's decision: a note body in conflict with another
 * program's version (Reload / Keep mine), a note deleted while it had unsaved
 * edits, a change whose file no longer exists. None of them will be written
 * until the user answers, so the save indicator shows "waiting for your
 * decision" rather than "saving", and its popover can re-open each prompt
 * (the toast may have been dismissed or scrolled away).
 *
 * Each prompt registers itself here; an entry drops out once `stillHeld`
 * says the decision has been made, however it was made.
 */
import { onVaultSwap } from '../core/vaultLifecycle';

export interface HeldDecision {
  /** The prompt's toast key; one entry per prompt. */
  key: string;
  /** The note it is about. */
  relPath(): string;
  /** One line for the save popover. */
  text: string;
  /** False once the decision has been made (by the prompt or otherwise). */
  stillHeld(): boolean;
  /** Shows the prompt again. */
  reopen(): void;
}

const held = new Map<string, HeldDecision>();
let listener: (() => void) | null = null;

/** Told whenever a decision is held or released, so the indicator can update. */
export function setHeldDecisionsListener(next: (() => void) | null): void {
  listener = next;
}

function changed(): void {
  try {
    listener?.();
  } catch (err) {
    console.error('[heldDecisions] listener threw:', err);
  }
}

export function holdDecision(decision: HeldDecision): void {
  held.set(decision.key, decision);
  changed();
}

export function releaseDecision(key: string): void {
  if (held.delete(key)) changed();
}

/** The decisions still waiting, newest last. Ones already made are dropped. */
export function heldDecisions(): HeldDecision[] {
  for (const [key, decision] of [...held]) {
    let still = false;
    try {
      still = decision.stillHeld();
    } catch {
      still = false;
    }
    if (!still) held.delete(key);
  }
  return [...held.values()];
}

/** Re-opens the prompt for `key`, if it is still waiting. */
export function reopenDecision(key: string): void {
  const decision = heldDecisions().find((d) => d.key === key);
  decision?.reopen();
}

onVaultSwap('pre-swap', 'heldDecisions', () => {
  held.clear();
  changed();
});
