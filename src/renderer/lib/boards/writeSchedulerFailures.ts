/**
 * writeSchedulerFailures — failure attribution + RETENTION for `createScheduler`
 * (split out of writeScheduler.ts, which sits at the 1000-LOC ci:file-sizes
 * limit).
 *
 * Attribution (moved verbatim): a per-failure-id Set populated by `fireWrite`
 * on rejection / partial failure, drained by `flush(key)` / `flushAll()` so the
 * Ctrl+S aggregate stays scoped to writes the caller awaited, plus the
 * Audit-16 4.7 per-key record so a key's next success prunes the ids its prior
 * failed fires attributed.
 *
 * Retention (Audit-19 EXT-5 / ERR-9, plan D6): the scheduler used to keep only
 * failure IDS. The failed fire's `getArgs` closure was gone, `flushAll`
 * re-fired only `pending`, and the quit dialog's "Stay open and retry" re-issued
 * nothing — so an edit whose write lost a OneDrive lock existed only in memory
 * (lost at exit) and in a preserved `.tmp`. A rejection whose code is in
 * `RETAINABLE` (a transient lock / IO / timeout) now keeps its `getArgs`; the
 * next `flushAll()` (Ctrl+S, quit drain, vault swap, Retry) re-fires it once.
 *
 * DECISION: user-deferred failures (drift-gate 'defer' / re-prompt budget —
 * plain Errors with no code) and validation errors are NOT retained: re-firing
 * them would re-prompt during a quit drain. `ci:failed-write-refire` pins that
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
  'WRITE_TIMEOUT',
]);

/** True when a performWrite rejection is a transient failure worth re-firing. */
export function isRetainableWriteError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && RETAINABLE.has(code);
}

export interface FailureLedger<TArgs> {
  /** Attribute failure ids to `key` (a failed fire). */
  recordFailed(key: string, ids: readonly string[]): void;
  /** A successful fire for `key`: prune its ids + any retained re-fire. */
  recordSuccess(key: string, primaryId: string): void;
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
      // Audit-7 L12 — a later success for the same id means it is no longer
      // failed; prune so `failures` can't grow for the whole session.
      failures.delete(primaryId);
      const recorded = failureIdsByKey.get(key);
      if (recorded) {
        for (const f of recorded) failures.delete(f);
        failureIdsByKey.delete(key);
      }
      retained.delete(key);
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
