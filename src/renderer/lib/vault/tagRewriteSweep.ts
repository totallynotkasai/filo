/**
 * Tag-rename / tag-removal sweep across every `.md` file in the vault.
 *
 * Two-phase shape (Phase 9.1, P1-5):
 *
 *   Phase 1 — pre-flight + plan: read each candidate file, compute its
 *   rewritten content, and build an in-memory list of `(path, content)`
 *   pairs to write. Files that no longer exist on disk are silently
 *   dropped from the plan (the rename intent is moot); files that exist
 *   but fail to read are recorded as failed so the caller can surface a
 *   toast.
 *
 *   Phase 2 — commit writes: execute each planned write, catching per-write
 *   failures locally so the loop reaches every file before reporting.
 *
 * Splitting the phases lets `fileTagsStore.renameTagEverywhere` /
 * `removeTagEverywhere` decide whether to commit their `.filo/tags.json`
 * + tile-def cascade based on the outcome — if any `.md` write failed,
 * the registry stays at the old name so a retry naturally targets only
 * the unwritten files (the metadata of the succeeded files no longer
 * mentions the old tag).
 *
 * Lives in `lib/vault/` (not `stores/`) because it's pure rewrite logic
 * that pulls reactive state through parameters rather than store imports
 * — keeps the heavy logic out of the already-large fileTagsStore module.
 */

import { rewriteTagInMarkdown, removeTagFromMarkdown, tagsEqual } from './tagRewriter';
import {
  writePendingRewrite,
  clearPendingRewrite,
  type TagRewriteSentinelPayload,
} from './tagRewriteSentinel';
import { reportError } from '../utils/errorBus';
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { onVaultSwap } from '../../core/vaultLifecycle';
import { PendingWritesFailedError, withDrainedWrites } from './vaultOperations';
import { writeMarkdownAndReconcile } from './syncOpenEditorsAfterDiskMutation';
import type { FileMetadata } from './vaultIndex';

/**
 * Polish phase 4.3 (2026-05-25) — full-function mutex. The
 * `tagRewriteSentinel` mutex protects only the sentinel JSON write; the
 * .md write loop inside `rewriteTagInAllMarkdown` was unguarded, so two
 * rapid tag renames (e.g. user renames `#draft` → `#review`, then
 * immediately renames `#review` → `#final` before the first sweep
 * resolves) could interleave per-file write IPCs. The first sweep's
 * still-pending `vault:write-existing-file-text` for `notes.md` racing
 * against the second sweep's reading-then-writing-the-same-file produces
 * order-dependent content — whichever IPC the OS scheduled last wins,
 * which may be the OLDER rename's rewrite.
 *
 * Lifting the mutex to the function level serialises full sweeps end-to-
 * end: each sweep's read+plan+write phases complete before the next one
 * starts. Cost is throughput (a 200-file rename will block the next
 * rename until done) but the correctness alternative would be a per-path
 * lock map, which is much more complex for a code path that fires at
 * human-visible cadences (not per-keystroke).
 *
 * Reset on vault swap so a straggling sweep tied to the outgoing vault
 * doesn't block the new vault's first sweep — the new vault's metadata
 * doesn't share file paths with the old, so the in-flight chain has no
 * coherent way to wait for it.
 */
let sweepInflight: Promise<MarkdownRewriteResult> | null = null;

onVaultSwap('pre-swap', 'tagRewriteSweep', () => {
  sweepInflight = null;
});

/** Test-only — drops the in-memory sweep mutex chain. */
export function __resetTagRewriteSweepForTests(): void {
  sweepInflight = null;
}

/**
 * Aggregate result of a sweep. `attempted` counts files whose frontmatter
 * genuinely needed rewriting (deduped against the `next === raw`
 * short-circuit); `succeeded` lists paths that hit disk; `failed` lists
 * paths whose read or write raised an error.
 *
 * Files that no longer exist on disk are silently dropped from all three
 * counters because the rewrite intent is moot — the caller should not
 * treat a missing file as a failure that blocks the commit.
 */
export interface MarkdownRewriteResult {
  attempted: number;
  succeeded: string[];
  failed: string[];
}

/**
 * Arguments for {@link rewriteTagInAllMarkdown}. Kept as a struct so call
 * sites read clearly at a glance — the runtime context (vaultRoot,
 * metadata, applyChanges) flows in alongside the rename arguments.
 */
export interface TagRewriteSweepArgs {
  vaultRoot: string;
  metadata: readonly FileMetadata[];
  oldName: string;
  /** `null` ⇒ remove the tag; otherwise rename it. */
  newName: string | null;
  /** Called after writes complete with the list of paths actually rewritten. */
  applyChanges: (relPaths: string[]) => Promise<void>;
  /** When provided, only rewrite candidate files whose path is in this set. */
  pathFilter?: ReadonlySet<string>;
}

/**
 * Walks every metadata entry that carries `oldName`, builds a rewrite
 * plan, then commits the writes. See module docstring for the two-phase
 * rationale. Per-write failures keep the recovery sentinel dirty for the
 * affected paths via `trackComponentWrite`'s normal lifecycle.
 *
 * Polish phase 4.3 — the full sweep is serialised through `sweepInflight`
 * so two rapid tag renames cannot interleave their `.md` write IPCs. See
 * the `sweepInflight` declaration above for the rationale.
 */
export async function rewriteTagInAllMarkdown(args: TagRewriteSweepArgs): Promise<MarkdownRewriteResult> {
  const prev = sweepInflight ?? Promise.resolve(emptySweepResult());
  // `then(fn, fn)` so a prior sweep that rejected still releases the chain
  // — the next call shouldn't be permanently blocked by an earlier throw.
  const next = prev.then(() => runSweep(args), () => runSweep(args));
  // Don't keep the resolved value on the chain (we only need a tail
  // pointer); a rejection is also swallowed so a downstream awaiter
  // doesn't accidentally surface another caller's failure.
  sweepInflight = next.then(
    () => emptySweepResult(),
    () => emptySweepResult(),
  );
  return next;
}

function emptySweepResult(): MarkdownRewriteResult {
  return { attempted: 0, succeeded: [], failed: [] };
}

async function runSweep(args: TagRewriteSweepArgs): Promise<MarkdownRewriteResult> {
  const { vaultRoot, metadata, oldName, newName, applyChanges, pathFilter } = args;
  if (!vaultRoot) return { attempted: 0, succeeded: [], failed: [] };

  // Audit-7 M2 — the plan holds only PATHS; the rewritten bytes are recomputed
  // from a fresh re-read inside the post-drain commit loop (not snapshotted
  // here), so a `nextContent` captured now can't go stale against an editor
  // body the drain later flushes. Phase 1 still computes `next` locally for the
  // `next === raw` dedup that decides whether a file needs rewriting at all.
  const plan: Array<{ path: string }> = [];
  const failed: string[] = [];

  for (const md of metadata) {
    // Audit 2.2 — case-insensitive match. The index preserves the file's
    // authored casing (`Project`) while the registry canonical may be
    // `project`; a strict `===` here skipped the file and the rename never
    // reached its `.md`. Fold to the identity used everywhere else.
    if (!md.tags.some((t) => tagsEqual(t, oldName))) continue;
    if (pathFilter && !pathFilter.has(md.path)) continue;

    let raw: string | null = null;
    try {
      // Phase 37 / 37.6 — canonical two-arg form.
      const readResult = await invokeOk('vault:read-file-text', vaultRoot, md.path);
      raw = readResult.content;
    } catch (err) {
      // Envelope failure (file deleted between scan + read, EACCES, …)
      // is distinguished from a non-envelope throw (programmer error,
      // out of memory) so we preserve the existing "file vanished →
      // silently drop, file present → record failure" semantics.
      if (!(err instanceof IpcEnvelopeError)) {
        reportError('tagRewriteSweep', err, `Pre-flight read failed for ${md.path}`);
        failed.push(md.path);
        continue;
      }
    }

    if (raw === null) {
      const exists = await window.filo.invoke('vault:file-exists', vaultRoot, md.path);
      if (exists) failed.push(md.path);
      continue;
    }

    const next = newName === null
      ? removeTagFromMarkdown(raw, oldName)
      : rewriteTagInMarkdown(raw, oldName, newName);
    if (next === raw) continue;
    plan.push({ path: md.path });
  }

  // Sprint B / B3 — lay down the recovery sentinel BEFORE Phase 2 begins so
  // a crash mid-write leaves a resume breadcrumb. The sentinel records the
  // rename intent (oldName / newName) and the planned target paths; the
  // tag rewriter is idempotent so a Resume on next open re-runs the sweep
  // safely (files already at newName are no-ops). Sentinel-write failure
  // aborts the rewrite — we'd rather refuse to proceed than commit writes
  // without a recovery breadcrumb.
  // 6.3 — keep the live payload so the removal path can re-write it with
  // incremental `committedPaths` progress as each .md is stripped.
  const sentinelPayload: TagRewriteSentinelPayload = {
    timestamp: Date.now(),
    oldName,
    newName,
    plan: plan.map((p) => p.path),
    // Phase 7.3 — snapshot files that ALREADY carry `newName` before the
    // sweep touches disk (a merge-rename into an existing tag, or files
    // the user independently tagged). Partial-state detection excludes
    // these so recovery doesn't falsely flag "some files already rewritten"
    // on every open. Empty for removals.
    preexistingNewNamePaths:
      newName === null
        ? []
        : metadata.filter((m) => m.tags.includes(newName)).map((m) => m.path),
    // 6.3 — filled incrementally below (removals only).
    committedPaths: [],
  };
  if (plan.length > 0) {
    try {
      await writePendingRewrite(vaultRoot, sentinelPayload);
    } catch (err) {
      reportError('tagRewriteSweep', err, 'Failed to write recovery sentinel, aborting');
      // Treat every planned path as failed so the caller knows the rewrite
      // didn't run. No writes have happened yet.
      for (const p of plan) failed.push(p.path);
      return { attempted: plan.length + failed.length, succeeded: [], failed };
    }
  }

  // Phase R2 — drain pending writers BEFORE the Phase 2 commit loop.
  // A debounced editor write armed against any planned path would
  // otherwise fire AFTER our rewrite and silently overwrite the
  // freshly-rewritten content with whatever the editor had in memory
  // before the rename. The Phase 1 read happened seconds (sometimes
  // longer) ago, so the editor's pending body could be newer than the
  // disk content we just rewrote. Wrap the commit loop in
  // `withDrainedWrites` so all in-flight writes flush before we touch
  // disk; the sweep mutex above already serialises concurrent sweeps.
  //
  // If the drain itself fails (a pending markdown write rejected on
  // EACCES/ENOSPC), we mark every planned path as failed so the caller
  // — fileTagsStore.renameTagEverywhere — keeps the registry at the
  // OLD name and re-prompts the user to retry. The sentinel stays in
  // place; next-open recovery will see it and replay.
  const succeeded: string[] = [];
  try {
    await withDrainedWrites(async () => {
      for (const item of plan) {
        try {
          // Audit-7 M2 — recompute the rewrite from a POST-DRAIN read instead of
          // a Phase-1 snapshot. `withDrainedWrites` (above) just flushed any
          // editor body a keystroke re-armed after the caller's up-front drain;
          // the Phase-1 read ran seconds ago (longer on a large vault), so a
          // snapshotted `nextContent` would predate that body and writing it
          // would silently roll the keystroke back — and the `mode: 'full'`
          // reconcile would reload the open editor to the stale body too. Reading
          // here, after the drain, keeps the live body and only swaps the tag.
          let freshRaw: string | null = null;
          try {
            const reread = await invokeOk('vault:read-file-text', vaultRoot, item.path);
            freshRaw = reread.content;
          } catch (err) {
            // A non-envelope throw (programmer error, OOM) is unexpected — let
            // the outer catch attribute the failure. An envelope failure means
            // the file vanished or is unreadable; resolve it like Phase 1 did.
            if (!(err instanceof IpcEnvelopeError)) throw err;
          }
          if (freshRaw === null) {
            // Mirror the Phase-1 policy: a genuinely-missing file is dropped (the
            // rewrite intent is moot), a present-but-unreadable file is a failure
            // the caller retries.
            const exists = await window.filo.invoke('vault:file-exists', vaultRoot, item.path);
            if (exists) failed.push(item.path);
            continue;
          }
          const freshNext = newName === null
            ? removeTagFromMarkdown(freshRaw, oldName)
            : rewriteTagInMarkdown(freshRaw, oldName, newName);
          if (freshNext === freshRaw) {
            // The post-drain bytes already lack the old tag (e.g. the flushed
            // editor body had dropped it). The file is already in the desired
            // state — skip the write; it's neither a failure nor a rewrite.
            continue;
          }
          // Phase 31 A4.5 — tag rewrites edit EXISTING files (found by the prior
          // metadata scan), so `writeMarkdownAndReconcile` uses the
          // `vault:write-existing-file-text` channel (create:false): a file
          // deleted out-of-band between scan and write surfaces as ENOENT
          // (→ failed) instead of being resurrected. `invokeOk` (inside the
          // helper) unwraps the `{ success: false, error }` envelope so a write
          // failure reaches `trackComponentWrite` / the failed-paths surface.
          // Phase 6.6 — coupled write+reconcile keyed to the SAME path we write.
          // `mode: 'full'` reloads any open editor on this rewritten file with
          // the new bytes (its pre-rewrite body would otherwise re-clobber the
          // rewrite on the next debounce; applyReloadFromDisk self-cancels,
          // 6.0.C2). `notifyOnError: false` keeps the bulk loop from spamming one
          // toast per file — the caller surfaces an aggregate retry toast. The
          // sweep operates on raw markdown text and is atomic with the pre-flight
          // scan, so it bypasses the debounced gateway deliberately.
          //
          // Audit-11 T2 (ACCEPTED — see KNOWN_LIMITATIONS.md #8) — there is a
          // narrow window: this loop runs inside `withDrainedWrites` (drained at
          // entry), so a keystroke typed into an ALREADY-PROCESSED file's editor
          // *during* a large sweep arms a fresh write after that drain. The
          // post-drain re-read above sees disk WITHOUT those keystrokes, and the
          // `mode: 'full'` reload here cancels the editor's armed write and swaps
          // in the rewritten (keystroke-free) body — losing the in-flight
          // keystrokes for that one file. Not closed in code because the fix
          // (frontmatter-only reconcile when `isPathPending(path)`) would couple
          // this deliberately store-free pure-rewrite module to scheduler state;
          // the race needs simultaneous typing + a vault-wide tag rename, the
          // .md tag rewrite still lands on disk, and undo restores the keystrokes.
          await writeMarkdownAndReconcile({
            vaultRoot,
            path: item.path,
            content: freshNext,
            mode: 'full',
            track: { notifyOnError: false },
          });
          succeeded.push(item.path);
          // 6.3 — for REMOVALS, persist the per-path commit breadcrumb
          // incrementally so a crash mid-sweep leaves the partial state
          // detectable on reopen (renames detect partial state from the index
          // and skip this extra write). The breadcrumb write is best-effort:
          // the .md strip already landed, so a failed breadcrumb only risks a
          // committedPaths list short by one — harmless, because recovery
          // converges forward idempotently regardless of the exact list.
          if (newName === null) {
            sentinelPayload.committedPaths.push(item.path);
            try {
              await writePendingRewrite(vaultRoot, sentinelPayload);
            } catch (breadcrumbErr) {
              reportError(
                'tagRewriteSweep',
                breadcrumbErr,
                `Failed to update tag-removal progress breadcrumb after ${item.path}`,
              );
            }
          }
        } catch (err) {
          reportError('tagRewriteSweep', err, `Failed to rewrite tag in ${item.path}`);
          failed.push(item.path);
        }
      }
    });
  } catch (err) {
    // PendingWritesFailedError → drain rejected; sentinel stays in place
    // for next-open recovery, and every planned path is treated as failed
    // so the caller's retry path picks them up. Any other throw is
    // unexpected and re-thrown.
    if (err instanceof PendingWritesFailedError) {
      for (const item of plan) {
        if (!succeeded.includes(item.path)) failed.push(item.path);
      }
      return { attempted: plan.length + failed.length, succeeded, failed };
    }
    throw err;
  }

  if (succeeded.length > 0) await applyChanges(succeeded);

  // Phase 6.6 — the open-editor reconcile now happens inside each
  // writeMarkdownAndReconcile in the write loop above (write-path ==
  // reconcile-path by construction), so the post-drain batch sync that used to
  // re-derive the (path, content) list from the plan is gone.

  // Sprint B / B16 — only clear the sentinel when EVERY planned path
  // succeeded. On partial failure (EACCES on a subset, mid-sweep
  // network blip, etc.) we leave the sentinel in place so the next
  // vault open can replay the rewrite via the recovery prompt. Tag
  // rewrites are idempotent — replaying against files that already
  // carry `#newName` is a no-op for those files, so the user only ever
  // sees the still-failing subset succeed on retry.
  //
  // The caller's retry toast in fileTagsStore still re-lays a fresh
  // sentinel covering just the still-failed paths when the user clicks
  // "Retry" inside the session; the next-open recovery is the safety
  // net for users who close the app before the toast retry fires.
  if (plan.length > 0 && failed.length === 0) {
    await clearPendingRewrite(vaultRoot);
  }

  return { attempted: plan.length + failed.length, succeeded, failed };
}
