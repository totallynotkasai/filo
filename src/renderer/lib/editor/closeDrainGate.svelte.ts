/**
 * closeDrainGate.
 *
 * A tab close / closeOthers drains every pending markdown/frontmatter/board
 * write, then (on a save failure) shows a "close anyway?" confirm, then re-runs
 * the drains once more right before the editors unmount. Through that entire
 * window the editors stay MOUNTED + EDITABLE, so a keystroke typed during the
 * drain or the confirm re-arms a debounce the drains' snapshot never saw — and
 * the unmount then destroys it. Extra flush passes can't close that window (the
 * interactive confirm can sit open for minutes).
 *
 * So the re-arm window is removed instead: while a close drain is in progress the editors go READ-ONLY (a visual
 * "saving…" freeze). No keystroke is accepted, so none can be stranded. Closing
 * the vault or opening another one freezes them the same way, from the save
 * before leaving until the swap has unmounted them.
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

// The swap unmounts the outgoing vault's editors (the `tabs` handler), then
// resets the gate so the NEW vault's editors aren't stranded read-only. Leaving
// holds the gate across that gap (`holdCloseDrainUntilSwap`), so no keystroke
// lands between the save before leaving and the unmount.
onVaultSwap(
  'pre-swap',
  'closeDrainGate',
  () => {
    depth = 0;
    draining = false;
  },
  { runAfter: ['tabs'] },
);

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
/**
 * Raises the gate for leaving the vault. The returned release lowers it (the
 * user chose to stay); when the vault is let go, the swap resets the gate
 * after the editors have unmounted, so they never thaw in between.
 */
export function holdCloseDrainUntilSwap(): () => void {
  depth++;
  draining = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    if (depth === 0) draining = false;
  };
}

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
