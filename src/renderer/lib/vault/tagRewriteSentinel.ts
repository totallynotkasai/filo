/**
 * Tag-rewrite recovery sentinel — survives a crash mid-tag-rename.
 *
 * A tag rename (`renameTagEverywhere`) or removal
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
import { ownSentinelPath } from './machineIdentity';
import { readOwnSentinel, clearOwnSentinel } from './machineSentinels';

/**
 * PER MACHINE (`.filo/tag-rewrite-pending.<machineId>.json`):
 * another machine must never "Resume" this machine's half-finished tag rename
 * (it would rewrite the same files concurrently) nor clear it.
 */
const ownTagRewritePath = (): string => ownSentinelPath('tag-rewrite');

/**
 * Mutex — serialises every read/write against the sentinel. Without this,
 * a rapid double-rename (two `renameTagEverywhere` calls firing back-to-back
 * before the first one's IPC settles) would interleave the read/write halves
 * of two sentinel writes and end up persisting whichever one happened to
 * resolve last instead of the one the user actually triggered last.
 * Mirrors the renameCascadeSentinel mutex.
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
  /**
   * Vault-relative paths that already carried `newName` BEFORE
   * the rewrite began (a merge-rename into an existing tag, or files the user
   * had independently tagged). Recorded at write time so partial-state
   * detection can exclude them: a file carrying `newName` only signals an
   * interrupted sweep if it WASN'T already a `newName` carrier. Empty for
   * removals (`newName === null`). Sentinels written before this field
   * existed read back as `[]` (forward-compatible).
   */
  preexistingNewNamePaths: string[];
  /**
   * Vault-relative paths whose `.md`
   * rewrite was CONFIRMED committed to disk, recorded INCREMENTALLY as the
   * sweep progresses. This is the per-path commit breadcrumb that lets reopen
   * detect a partial REMOVAL: the absence of a tag is indistinguishable from
   * "never had it" via the index alone, so renames detect partial state from
   * the index (`hasPartialTagRewriteState`) but removals need recorded
   * progress (`hasPartialTagRemovalState`). Populated for removals; left `[]`
   * for renames (which don't need it). Sentinels written before this field
   * existed read back as `[]` (forward-compatible).
   */
  committedPaths: string[];
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
    // Failures throw an IpcEnvelopeError (callers like
    // fileTagsStore.renameTagEverywhere abort on throw).
    //
    // Deliberately bypasses the note writer's fresh-read discipline:
    // that guards user-owned `.md` files; this is a Filo-owned, single-writer
    // crash-recovery sentinel no editor hydrates from.
    // allow-direct-write: `.filo/tag-rewrite-pending.json` is a one-shot
    // crash-recovery sentinel — not a `.md` file, no editor hydrates from it.
    await invokeOk(
      'vault:write-file-text',
      vaultRoot,
      ownTagRewritePath(),
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
      // EACCES/EBUSY reach reportError; ENOENT (already absent) is the
      // desired terminal state. Clears this machine's file only.
      await clearOwnSentinel(vaultRoot, 'tag-rewrite');
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
      // ENOENT is the steady-state "no sentinel" case and resolves to `{}`.
      // Any other failure resolves to `{ unreadable: true }` so the recovery
      // UI still surfaces.
      const result = await readOwnSentinel(vaultRoot, 'tag-rewrite');
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
    // A present-but-empty file is a partial write: a crash created the
    // sentinel but never filled it. Surface it as `unreadable` rather than
    // treating it as clean (same rule as a zero-byte `.dirty`).
    if (!content) return { unreadable: true };
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
      // `preexistingNewNamePaths` is required in new sentinels but
      // absent in ones written by an older app version; tolerate absence
      // (default `[]`) so an upgrade-across-a-pending-rewrite still recovers.
      // When present it must be a string[], else the sentinel is corrupt.
      const pre = parsed.preexistingNewNamePaths;
      if (pre !== undefined && (!Array.isArray(pre) || !pre.every((p) => typeof p === 'string'))) {
        return { unreadable: true };
      }
      // Same forward-compatible tolerance for the per-path commit breadcrumb:
      // absent in older sentinels (read back as `[]`), a string[] when present.
      const committed = parsed.committedPaths;
      if (committed !== undefined && (!Array.isArray(committed) || !committed.every((p) => typeof p === 'string'))) {
        return { unreadable: true };
      }
      return {
        payload: {
          timestamp: parsed.timestamp,
          oldName: parsed.oldName,
          newName: parsed.newName,
          plan: parsed.plan,
          preexistingNewNamePaths: pre ?? [],
          committedPaths: committed ?? [],
        },
      };
    } catch {
      return { unreadable: true };
    }
  });
}

/**
 * Detect whether a tag rewrite (rename)
 * had partial progress at crash time. Returns true when a file in the vault
 * index carries `newName` that WASN'T already a `newName` carrier before the
 * rewrite — meaning some files were rewritten before the crash and some still
 * carry `oldName`. The naive "Discard plan" path would otherwise leave the
 * vault split between the two tag names with no warning.
 *
 * `preexistingNewNamePaths` (snapshotted in the sentinel at write time) is
 * excluded from the scan, so a merge-rename into an existing tag doesn't
 * falsely trip "partial rewrite detected" on every open. (A file that carried BOTH
 * tags pre-rename is also exempt; the sentinel records no per-path commit
 * status, so erring toward fewer false alarms is the honest trade-off.)
 *
 * Returns false for removals (`newName === null`): the absence of a tag is
 * indistinguishable from "never had it" via the index, so this index-based
 * heuristic can't classify a removal. Removals are classified by
 * {@link hasPartialTagRemovalState} from the sentinel's recorded
 * `committedPaths` instead — the call site branches on `newName`.
 *
 * Pure function over an iterable of `{ path, tags }`. Lets the recovery
 * dialog be tested without mounting the vault index.
 */
export function hasPartialTagRewriteState(
  newName: string | null,
  metadata: Iterable<{ path: string; tags: readonly string[] }>,
  preexistingNewNamePaths: Iterable<string> = [],
): boolean {
  if (newName === null) return false;
  const exempt = new Set(preexistingNewNamePaths);
  for (const m of metadata) {
    if (m.tags.includes(newName) && !exempt.has(m.path)) return true;
  }
  return false;
}

/**
 * Detect whether a tag REMOVAL had
 * partial progress at crash time, from the sentinel's incrementally-recorded
 * `committedPaths` rather than the index.
 *
 * Returns true when ANY planned file had its tag stripped before the sweep
 * stopped (crash, kill, per-file failure). Because the sweep only leaves the
 * sentinel in place when it did NOT finish cleanly (a clean sweep clears it),
 * a present removal sentinel with ≥1 committed path means the vault is in an
 * incomplete-removal state: some files no longer carry the tag while the
 * registry / remaining files still do. The recovery dialog then offers
 * "Finalise & discard" (converge the removal forward — idempotent, since
 * already-stripped files are no-ops) instead of a bare "Discard plan" that
 * would leave the vault split.
 *
 * An empty `committedPaths` means the sweep crashed before stripping any file
 * — the pre-removal state (every planned file still tagged) is internally
 * consistent, so this is NOT partial and the bare Discard semantics stand.
 *
 * Mirrors the "any witness ⇒ partial" shape of {@link hasPartialTagRewriteState}
 * (which treats even an all-rewritten sentinel as partial so Finalise clears
 * it). Pure function over an iterable of paths for testability.
 */
export function hasPartialTagRemovalState(
  committedPaths: Iterable<string>,
): boolean {
  // Non-empty ⇒ at least one file was stripped before the sweep stopped.
  // Pull a single element (works for arrays and lazy generators alike).
  return committedPaths[Symbol.iterator]().next().done !== true;
}

/** Test-only — drops the in-memory mutex chain. Production never needs this. */
export function __resetTagRewriteSentinelForTests(): void {
  lastOp = Promise.resolve();
}

// Vault-swap reset: drop the mutex chain so the new vault's first sentinel op
// isn't queued behind ops targeting the outgoing vault.
onVaultSwap('pre-swap', 'tagRewriteSentinel', () => {
  lastOp = Promise.resolve();
});
