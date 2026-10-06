/**
 * writeSchedulerFailures — failure attribution + RETENTION for `createScheduler`,
 * kept apart from the queueing in writeScheduler.ts.
 *
 * A board write held for a drift answer (`BOARD_DRIFT_HELD`) is retained so
 * Keep local can re-fire it, but the scheduler's `holdRetained` keeps it from
 * re-firing (and re-asking) until the answer is in. A `.filo/` settings or
 * shortcuts write held the same way (`CONFIG_DRIFT_HELD`) is retained too; a
 * re-fire of it is refused at once without asking again.
 *
 * Attribution: a per-failure-id Set populated by `fireWrite` on rejection /
 * partial failure, drained by `flush(key)` / `flushAll()` so the Ctrl+S
 * aggregate stays scoped to writes the caller awaited, plus a per-key record so
 * a key's next success prunes the ids its prior failed fires attributed.
 *
 * Retention: a rejection whose code is in `RETAINABLE` (a transient lock / IO /
 * timeout) keeps its `getArgs`; the next `flushAll()` (Ctrl+S, quit drain,
 * vault swap, Retry) re-fires it once. Without this, an edit whose write lost
 * e.g. a OneDrive lock would exist only in memory and be lost at exit.
 *
 * DECISION: user-deferred failures (drift-gate 'defer' / re-prompt budget —
 * plain Errors with no code) and validation errors are NOT retained: re-firing
 * them would re-prompt during a quit drain. `gates:failed-write-refire` pins that
 * `RETAINABLE` never gains a drift-defer marker.
 */

export const RETAINABLE: ReadonlySet<string> = new Set([
  'EPERM',
  'EBUSY',
  'EACCES',
  'EAGAIN',
  'ENOSPC',
  'EIO',
  'BOARD_PATH_HELD',
  'BOARD_MOVE_HELD',
  'BOARD_FOLDER_MISSING',
  'BOARD_DRIFT_HELD',
  'BOARD_ORIGINAL_NOT_KEPT',
  'CONFIG_DRIFT_HELD',
  'WRITE_TIMEOUT',
]);

/**
 * True when a performWrite rejection is a transient failure worth re-firing.
 * `ioError` also admits `IO_ERROR`, for schedulers whose payload is a whole
 * snapshot rebuilt at fire time.
 */
export function isRetainableWriteError(err: unknown, ioError = false): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return false;
  return RETAINABLE.has(code) || (ioError && code === 'IO_ERROR');
}

export interface FailureLedger<TArgs> {
  /** Attribute failure ids to `key` (a failed fire). */
  recordFailed(key: string, ids: readonly string[]): void;
  /**
   * A successful fire for `key`: prune its ids + any retained re-fire.
   * Returns the ids its earlier failed fires attributed, besides `primaryId`.
   */
  recordSuccess(key: string, primaryId: string): string[];
  /** Consume (delete) one attributed id; true when it was present. */
  consume(id: string): boolean;
  /** Keep a failed fire's args getter for a later re-fire. */
  retain(key: string, getArgs: () => TArgs | null): void;
  /** A newer schedule for `key` supersedes any retained args. */
  release(key: string): void;
  /** Removes and returns the retained getters (all, or just `key`'s). */
  takeRetained(key?: string): Array<[string, () => TArgs | null]>;
  hasRetained(key?: string): boolean;
  clear(): void;
  size(): number;
}

export function createFailureLedger<TArgs>(): FailureLedger<TArgs> {
  const failures = new Set<string>();
  const failureIdsByKey = new Map<string, Set<string>>();
  const retained = new Map<string, () => TArgs | null>();
  return {
    recordFailed(key, ids) {
      let recorded = failureIdsByKey.get(key);
      if (!recorded) {
        recorded = new Set<string>();
        failureIdsByKey.set(key, recorded);
      }
      for (const f of ids) {
        failures.add(f);
        recorded.add(f);
      }
    },
    recordSuccess(key, primaryId) {
      // A later success for the same id means it is no longer
      // failed; prune so `failures` can't grow for the whole session.
      failures.delete(primaryId);
      const recorded = failureIdsByKey.get(key);
      const others: string[] = [];
      if (recorded) {
        for (const f of recorded) {
          failures.delete(f);
          if (f !== primaryId) others.push(f);
        }
        failureIdsByKey.delete(key);
      }
      retained.delete(key);
      return others;
    },
    consume: (id) => failures.delete(id),
    retain(key, getArgs) {
      retained.set(key, getArgs);
    },
    release(key) {
      retained.delete(key);
    },
    takeRetained(key) {
      if (key !== undefined) {
        const g = retained.get(key);
        retained.delete(key);
        return g ? [[key, g]] : [];
      }
      const all = Array.from(retained.entries());
      retained.clear();
      return all;
    },
    hasRetained: (key) => (key === undefined ? retained.size > 0 : retained.has(key)),
    clear() {
      failures.clear();
      failureIdsByKey.clear();
      retained.clear();
    },
    size: () => failures.size,
  };
}

// ── Retry fan-out ────────────────────────────────────────────────────

type RetryHook = () => Promise<{ failed: string[] }>;
// allow-module-state: process-wide registry of scheduler instances (not vault data; each scheduler resets its own ledger on swap)
const retryHooks = new Set<RetryHook>();

/** Each `createScheduler` registers its `retryFailed`; returns an unregister. */
export function registerRetryHook(hook: RetryHook): () => void {
  retryHooks.add(hook);
  return () => retryHooks.delete(hook);
}

/**
 * Re-fires every retained failed write in every scheduler (board, markdown
 * gateway, frontmatter, config, misc) and awaits them. Backs the save-failed
 * toast's Retry and the quit dialog's "Retry now".
 */
export async function retryAllFailedWrites(): Promise<{ failed: string[] }> {
  const results = await Promise.all(Array.from(retryHooks, (h) => h().catch(() => ({ failed: ['<retry>'] }))));
  return { failed: results.flatMap((r) => r.failed) };
}
