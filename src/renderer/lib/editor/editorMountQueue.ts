/**
 * Mounts editors in the browser's idle time.
 *
 * Constructing a TipTap editor and loading its note costs tens of
 * milliseconds on a large board (the editor, and the re-renders its note's
 * load sets off). A board that built one per card in a single flush froze
 * for seconds (21 s at 300 cards). Views that show a static preview first
 * (`LazyTextTileBody`) queue their editor here instead. The preview already
 * shows the text and a press mounts at once, so a queued mount is never
 * urgent: it waits for idle time, so typing, scrolling and painting go
 * first. Cards on screen go before cards just off it.
 *
 * A job's `run` must do its mount synchronously (`flushSync`), so its cost
 * falls inside the idle period it ran in.
 */

/** At most this many mounts per idle period, even when each is cheap. */
export const MOUNTS_PER_IDLE = 4;
/** An idle period is at most 50 ms; don't start a mount with less than this left. */
const MIN_REMAINING_MS = 8;
/** Mount anyway after this long without idle time (a board that stays busy). */
const IDLE_TIMEOUT_MS = 1000;

interface Job {
  run: () => void;
  onScreen: () => boolean;
  seq: number;
}

interface IdleDeadlineLike {
  timeRemaining(): number;
  didTimeout: boolean;
}

// allow-module-state: pending mounts of mounted components; each cancels its own job on destroy
const pending = new Set<Job>();
let seq = 0;
let scheduled = false;

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(runIdle, { timeout: IDLE_TIMEOUT_MS });
  } else {
    // No idle callbacks (jsdom): a frame's worth of time per batch.
    setTimeout(() => runIdle({ timeRemaining: () => 16, didTimeout: false }), 16);
  }
}

function runIdle(deadline: IdleDeadlineLike): void {
  scheduled = false;
  if (pending.size === 0) return;
  const ordered = [...pending].sort(
    (a, b) => Number(safeOnScreen(b)) - Number(safeOnScreen(a)) || a.seq - b.seq,
  );
  let done = 0;
  for (const job of ordered) {
    if (done >= MOUNTS_PER_IDLE) break;
    if (done > 0 && deadline.timeRemaining() < MIN_REMAINING_MS) break;
    pending.delete(job);
    done++;
    try {
      job.run();
    } catch (err) {
      console.error('[editorMountQueue] mount failed', err);
    }
  }
  if (pending.size > 0) schedule();
}

function safeOnScreen(job: Job): boolean {
  try {
    return job.onScreen();
  } catch {
    return false;
  }
}

/**
 * Queues `run` for idle time; `onScreen` is asked each time so a card
 * scrolled into view goes first. Returns a cancel function (call it on
 * destroy, or when the caller mounts at once itself).
 */
export function queueEditorMount(run: () => void, onScreen: () => boolean): () => void {
  const job: Job = { run, onScreen, seq: seq++ };
  pending.add(job);
  schedule();
  return () => {
    pending.delete(job);
  };
}

/** Mounts still waiting (tests). */
export function pendingEditorMounts(): number {
  return pending.size;
}
