/**
 * watcherSupervisor — owns the reopen state machine for `FileWatcher`'s live `fs.watch` handle.
 * Three states:
 *
 *  - `active`        — the OS watch handle is alive and emitting events
 *                      normally.
 *  - `reconnecting`  — the live handle threw `'error'` (or `fs.watch`
 *                      itself failed synchronously). The supervisor is
 *                      retrying with exponential backoff. The reconcile
 *                      walker continues to run during this state so
 *                      external edits still surface, just at the slower
 *                      30 s cadence rather than the live debounce.
 *  - `suspended`     — terminal state reached after `stop()`. The
 *                      supervisor never transitions out of it.
 *
 * The supervisor publishes state changes to every BrowserWindow via the
 * `vault:watcher-state` IPC event so the renderer can show a banner /
 * toast when the watcher transitions to `reconnecting` (and clear it
 * when it transitions back to `active`).
 *
 * Encapsulating the retry policy in this module keeps `FileWatcher.ts`
 * focused on event classification + reconciliation; the supervisor is a
 * pure state machine the watcher drives via three callbacks
 * (openLiveWatcher / closeLiveWatcher / notifyLegacyFailed).
 */

import { BrowserWindow } from 'electron';

/**
 * Reopen backoff schedule. On an OS-level `fs.watch` `'error'` event we
 * transition into `reconnecting` and retry the live watcher at increasing
 * intervals until it survives the open. The first retry is fast (1 s)
 * because most errors are transient (network share blip, antivirus scanner
 * momentarily holding the directory). After three quick attempts the
 * backoff jumps to 5 minutes — at that point the user has very likely
 * unmounted the drive and is unlikely to remount it within seconds.
 *
 * Capped: once we exhaust the schedule, every subsequent retry uses the
 * tail value (300 000 ms = 5 min) until the watcher succeeds or `stop()`
 * is called.
 */
export const WATCHER_REOPEN_BACKOFF_MS = [1_000, 5_000, 30_000, 300_000] as const;

/**
 * State the supervisor publishes to the renderer via `vault:watcher-state`.
 */
export type WatcherState = 'active' | 'reconnecting' | 'suspended';

export interface WatcherStatePayload {
  vaultPath: string;
  state: WatcherState;
  /**
   * Present when state === 'reconnecting'; identifies the human-readable
   * reason from the underlying `'error'` event (or the synchronous
   * `fs.watch` throw). Lets the renderer toast surface a concrete reason
   * — "ENOSPC: System inotify limit reached" — rather than the generic
   * "watcher failed" copy.
   */
  reason?: string;
  /**
   * Number of consecutive retries the supervisor has performed without a
   * successful re-watch. Resets on the first successful re-watch back to
   * `active`. Lets the renderer rate-limit the toast it shows so a long
   * unavailability doesn't pile a new toast on every backoff tick.
   */
  attempt?: number;
}

export interface WatcherSupervisorCallbacks {
  /**
   * Opens (or re-opens) the live `fs.watch` handle. Returns true on
   * success, false if the synchronous `fs.watch` call threw (caller
   * already handled the error path via `handleWatcherError`).
   */
  openLiveWatcher(): boolean;
}

/**
 * Standalone state machine driving the live watcher reopen lifecycle.
 * `FileWatcher` instantiates one of these per vault and delegates the
 * supervisor concerns (broadcast state, schedule retry, clear retry) to
 * it.
 */
export class WatcherSupervisor {
  private state: WatcherState = 'active';
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private aborted = false;

  constructor(
    private readonly vaultPath: string,
    private readonly callbacks: WatcherSupervisorCallbacks,
  ) {}

  /** Current supervisor state. */
  getState(): WatcherState {
    return this.state;
  }

  /** Number of retries the supervisor has performed since the last successful open. */
  getRetryAttempt(): number {
    return this.retryAttempt;
  }

  /**
   * Records a successful (re)open of the live watcher. Resets the retry
   * counter and broadcasts `active` only when this was a recovery from
   * `reconnecting` so the renderer doesn't surface a "watcher reconnected"
   * toast on every vault open.
   */
  noteOpenSuccess(): void {
    if (this.aborted) return;
    if (this.retryAttempt > 0) {
      this.retryAttempt = 0;
      this.broadcastState('active');
    } else {
      this.state = 'active';
    }
  }

  /**
   * Records a live-watcher error (synchronous fs.watch throw OR async
   * 'error' event from the handle). Transitions to `reconnecting` and
   * schedules the next retry via the backoff schedule.
   */
  noteError(reason: string): void {
    if (this.aborted) return;
    this.broadcastState('reconnecting', reason);
    this.scheduleRetry();
  }

  /**
   * Terminal teardown. Cancels any pending retry timer and broadcasts
   * `suspended` exactly once. Idempotent — subsequent calls no-op so
   * `FileWatcher.stop()` can call it without ordering hazards.
   */
  shutdown(): void {
    if (this.aborted) return;
    this.aborted = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryAttempt = 0;
    this.broadcastState('suspended');
  }

  /**
   * Broadcasts a state-change event for the supervisor. The renderer
   * subscribes to `vault:watcher-state` and surfaces a banner / toast
   * based on `state` + `attempt`.
   */
  private broadcastState(state: WatcherState, reason?: string): void {
    // Note: we publish `suspended` even after `aborted` flips, because
    // `shutdown()` flips abort and then calls this; the guard below
    // therefore only fires on a stale-timer follow-up.
    if (this.aborted && state !== 'suspended') return;
    this.state = state;
    const payload: WatcherStatePayload = {
      vaultPath: this.vaultPath,
      state,
      ...(reason !== undefined ? { reason } : {}),
      ...(state === 'reconnecting' ? { attempt: this.retryAttempt } : {}),
    };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('vault:watcher-state', payload);
    }
  }

  /**
   * Arms a one-shot timer at the current backoff index and fires the
   * supplied retry callback when it elapses. Idempotent — if a retry is
   * already armed, drops the existing timer and rearms with the current
   * attempt delay.
   */
  private scheduleRetry(): void {
    if (this.aborted) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const idx = Math.min(this.retryAttempt, WATCHER_REOPEN_BACKOFF_MS.length - 1);
    const delay = WATCHER_REOPEN_BACKOFF_MS[idx];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.aborted) return;
      this.retryAttempt += 1;
      // Re-open. If it fails again, FileWatcher's error handler calls
      // back into `noteError` and the next retry is scheduled with the
      // bumped attempt counter.
      this.callbacks.openLiveWatcher();
    }, delay);
  }
}
