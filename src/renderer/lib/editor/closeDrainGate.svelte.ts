/**
 * closeDrainGate — Audit-17 5.7.
 *
 * A tab close / closeOthers drains every pending markdown/frontmatter/board
 * write, then (on a save failure) shows a "close anyway?" confirm, then re-runs
 * the drains once more right before the editors unmount. Through that entire
 * window the editors stay MOUNTED + EDITABLE, so a keystroke typed during the
 * drain or the confirm re-arms a debounce the drains' snapshot never saw — and
 * the unmount then destroys it. Audit-16 6.7's second flush narrowed the window
 * but a keystroke landing after the last drain's snapshot (or during the
 * interactive confirm, which can sit open for minutes) is still lost, with only
 * stale disk content recoverable.
 *
 * The fix removes the re-arm window instead of chasing it with more flush
 * passes: while a close drain is in progress the editors go READ-ONLY (a visual
 * "saving…" freeze). No keystroke is accepted, so none can be stranded.
 *
 * One global flag (not per-tab): a close drain is brief in the no-failure case,
 * and during a failed-drain confirm freezing every open editor is exactly the
 * desired "we're deciding whether to discard your unsaved work — stop typing"
 * state. `runWithCloseDrain` owns begin/end via try/finally so an early return
 * (user cancels) or a thrown drain can never strand the gate (which would freeze
 * editing for the rest of the session).
 *
 * Rune `$state` so the TipTap editors (DocumentEditor / TextTile) can react via
 * an `$effect` that calls `editor.setEditable(...)`.
 */

import { onVaultSwap } from '../../core/vaultLifecycle';

let draining = $state(false);
let depth = 0; // reentrancy / overlapping closes — only the outermost clears.

// A vault swap landing mid-close-drain (rare) must not strand the editors of the
// NEW vault read-only — reset the gate to idle. (`runWithCloseDrain`'s try/finally
// already covers the in-process path; this is the cross-vault backstop.)
onVaultSwap('pre-swap', 'closeDrainGate', () => {
  depth = 0;
  draining = false;
});

export const closeDrainGate = {
  /** True while a tab-close drain (drain → confirm → re-drain → unmount) is in flight. */
  get draining(): boolean {
    return draining;
  },
};

/**
 * Runs `fn` with the close-drain gate raised, lowering it again when `fn`
 * settles (success, early return, or throw). Nested/overlapping closes share
 * the flag; only the outermost release clears it.
 */
export async function runWithCloseDrain<T>(fn: () => Promise<T>): Promise<T> {
  depth++;
  draining = true;
  try {
    return await fn();
  } finally {
    depth--;
    if (depth <= 0) {
      depth = 0;
      draining = false;
    }
  }
}

/** Test-only — force the gate back to idle (per-test cleanup). */
export function __resetCloseDrainGateForTests(): void {
  depth = 0;
  draining = false;
}
