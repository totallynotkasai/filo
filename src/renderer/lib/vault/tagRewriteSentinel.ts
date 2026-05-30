/**
 * Tag-rewrite recovery sentinel — survives a crash mid-tag-rename.
 *
 * Sprint B / B3. A tag rename (`renameTagEverywhere`) or removal
 * (`removeTagEverywhere`) walks every metadata entry, builds a write plan,
 * and commits N disk writes before applying the registry / tile-def cascade.
 * If the process dies mid-Phase-2 (crash, power loss, OS kill), the .md
 * files are in a mixed state — some carry the new tag, some still carry the
 * old. The user's `.filo/tags.json` and `.board.json` tile defs were not
 * touched (the registry commit gates on all writes succeeding), so the next
 * vault open sees an inconsistent vault and the user has no idea why.
 *
 * The sentinel records the rename intent BEFORE Phase 2 begins. On vault
 * open, if the sentinel is present, the recovery modal offers to:
 *
 *   - Resume: re-run the rewrite sweep over the planned paths. Already-
 *     rewritten files are no-ops (the rewriter is idempotent — a file
 *     carrying `newName` already won't match `oldName`).
 *   - Discard: delete the sentinel and run `pruneOrphanFileTags` to
 *     reconcile the in-memory registry against whatever's actually on disk.
 *
 * Lives in `lib/vault/` because it's pure I/O orchestration (no UI). The
 * store layer (fileTags) reads the sentinel on vault open and wires the
 * Resume / Discard handlers.
 */

import { reportError } from '../utils/errorBus';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { invokeOk } from '../utils/invokeOk';
import { onVaultSwap } from '../../core/vaultLifecycle';

const TAG_REWRITE_SENTINEL_PATH = '.filo/tag-rewrite-pending.json';

/**
 * Mutex — serialises every read/write against the sentinel. Without this,
 * a rapid double-rename (two `renameTagEverywhere` calls firing back-to-back
 * before the first one's IPC settles) would interleave the read/write halves
 * of two sentinel writes and end up persisting whichever one happened to
 * resolve last instead of the one the user actually triggered last.
 *
 * Mirrors the renameCascadeSentinel mutex (Sprint 35.3) by design: the same
 * recovery sentinel pattern, the same crash window, the same hazard.
 */
let lastOp: Promise<unknown> = Promise.resolve();

function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const next = lastOp.then(fn, fn);
  lastOp = next.catch(() => undefined);
  return next;
}

/**
 * Persisted shape — kept compact so a crash mid-sentinel-write leaves
 * either a parseable payload or a clearly invalid one (truncated JSON).
 * No optional fields with `undefined`; absence of a field is meaningful.
 */
export interface TagRewriteSentinelPayload {
  /** ms-since-epoch when the sentinel was laid down. */
  timestamp: number;
  /** The tag the rewrite is migrating FROM. */
  oldName: string;
  /** The tag the rewrite is migrating TO, or `null` for a removal. */
  newName: string | null;
  /** Vault-relative paths the rewrite was planning to touch. */
  plan: string[];
}

export interface ReadResult {
  /** Present when the sentinel was found and parsed successfully. */
  payload?: TagRewriteSentinelPayload;
  /**
   * Set when the sentinel was found but unreadable / unparseable. Lets the
   * caller distinguish "no recovery needed" (clean steady state) from
   * "we know something went wrong but can't tell what" (recovery UI should
   * still surface a toast).
   */
  unreadable?: boolean;
}

/**
 * Writes the sentinel before Phase 2 starts. Awaited so a sentinel-write
 * failure aborts the rewrite (we'd rather not lose data than rewrite
 * silently without a recovery breadcrumb).
 */
export function writePendingRewrite(
  vaultRoot: string,
  payload: TagRewriteSentinelPayload,
): Promise<void> {
  return withMutex(async () => {
    if (!vaultRoot) return;
    // Phase 31 A1.6 — failures carry an IpcEnvelopeError with the
    // channel + code (callers like fileTagsStore.renameTagEverywhere
    // already abort on throw, surfacing the failure to the user).
    // Phase 1 (CONSOLIDATION_PLAN) — switched to `invokeOk` so the
    // envelope check is part of the call shape.
    await invokeOk(
      'vault:write-file-text',
      vaultRoot,
      TAG_REWRITE_SENTINEL_PATH,
      JSON.stringify(payload),
    );
  });
}

/**
 * Deletes the sentinel after Phase 2 completes (whether successful or
 * partially-failed — the caller decides). Failure to delete is logged but
 * not thrown: the sentinel will be re-evaluated on next open and the user
 * can dismiss it manually.
 */
export function clearPendingRewrite(vaultRoot: string): Promise<void> {
  return withMutex(async () => {
    if (!vaultRoot) return;
    try {
      const fullPath = `${vaultRoot.replace(/[\\/]$/, '')}/${TAG_REWRITE_SENTINEL_PATH}`;
      // Phase 31 A1.6 — invokeOk surfaces { ok:false } as a thrown
      // IpcEnvelopeError so EACCES/EBUSY paths reach reportError;
      // ENOENT (sentinel already absent) is the desired terminal
      // state, so we swallow it.
      try {
        await invokeOk('vault:delete', vaultRoot, fullPath);
      } catch (err) {
        if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') return;
        throw err;
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
        return;
      }
      reportError(
        'tagRewriteSentinel.clear',
        err,
        "Could not delete the tag-rewrite sentinel — you'll see the resume prompt again on next open",
      );
    }
  });
}

/**
 * Reads the sentinel if present. Returns `{}` (no `payload`, no
 * `unreadable`) for the steady-state "no sentinel" case so the caller's
 * happy path is a single `if (result.payload)` check.
 */
export function readPendingRewrite(vaultRoot: string): Promise<ReadResult> {
  return withMutex(async () => {
    if (!vaultRoot) return {};
    let content: string;
    try {
      // Phase 37 / 37.6 — canonical two-arg form.
      // Phase 1 (CONSOLIDATION_PLAN) — `invokeOk` throws on
      // `{ success: false }`; ENOENT is the steady-state "no sentinel"
      // case and resolves to `{}`. Any other failure resolves to
      // `{ unreadable: true }` so the recovery UI still surfaces.
      const result = await invokeOk('vault:read-file-text', vaultRoot, TAG_REWRITE_SENTINEL_PATH);
      content = result.content;
    } catch (err) {
      if (err instanceof IpcEnvelopeError) {
        if (err.code === 'ENOENT') return {};
        return { unreadable: true };
      }
      reportError(
        'tagRewriteSentinel.read',
        err,
        "Couldn't read the tag-rewrite sentinel — Filo can't verify the previous rename completed",
      );
      return { unreadable: true };
    }
    if (!content) return {};
    try {
      const parsed = JSON.parse(content) as Partial<TagRewriteSentinelPayload>;
      if (
        typeof parsed.timestamp !== 'number' ||
        typeof parsed.oldName !== 'string' ||
        !(parsed.newName === null || typeof parsed.newName === 'string') ||
        !Array.isArray(parsed.plan) ||
        !parsed.plan.every((p) => typeof p === 'string')
      ) {
        return { unreadable: true };
      }
      return {
        payload: {
          timestamp: parsed.timestamp,
          oldName: parsed.oldName,
          newName: parsed.newName,
          plan: parsed.plan,
        },
      };
    } catch {
      return { unreadable: true };
    }
  });
}

/**
 * IMPL_PLAN_2026-05-26 / Item 4 — Detect whether a tag rewrite (rename)
 * had partial progress at crash time. Returns true when ANY file in the
 * vault index already carries `newName` — meaning some files were
 * rewritten before the crash and some still carry `oldName`. The naive
 * "Discard plan" path would otherwise leave the vault split between the
 * two tag names with no warning.
 *
 * Always returns false for removals (`newName === null`) — the sentinel
 * format doesn't record per-path commit status, so there's no honest way
 * to detect partial removal from the metadata alone. A future revision
 * could broaden detection if removal partial-state turns out to bite
 * users in practice.
 *
 * Pure function over an iterable of `{ tags: readonly string[] }`. Lets
 * the recovery dialog be tested without mounting the vault index.
 */
export function hasPartialTagRewriteState(
  newName: string | null,
  metadata: Iterable<{ tags: readonly string[] }>,
): boolean {
  if (newName === null) return false;
  for (const m of metadata) {
    if (m.tags.includes(newName)) return true;
  }
  return false;
}

/** Test-only — drops the in-memory mutex chain. Production never needs this. */
export function __resetTagRewriteSentinelForTests(): void {
  lastOp = Promise.resolve();
}

// Phase 3 (IMPL_PLAN 2026-05-25) — vault-swap reset. The mutex chain
// head holds promises tethered to the outgoing vault's sentinel path. A
// straggling sentinel read/write enqueued just before swap would
// otherwise drag the new vault's first sentinel op behind a chain that
// targets a vault root that's no longer active. Resetting to a fresh
// Promise.resolve() at pre-swap drops the prior chain so the new
// vault's first sentinel op runs immediately.
onVaultSwap('pre-swap', 'tagRewriteSentinel', () => {
  lastOp = Promise.resolve();
});
