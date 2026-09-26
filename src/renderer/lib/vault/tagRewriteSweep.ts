/**
 * Tag-rename / tag-removal sweep across every `.md` file in the vault.
 *
 * Two-phase shape:
 *
 *   Phase 1 — pre-flight + plan: read each candidate file, compute its
 *   rewritten content, and build an in-memory list of `(path, content)`
 *   pairs to write. Files that no longer exist on disk are dropped from
 *   the plan (the index was behind); files that exist but fail to read
 *   are recorded as failed so the caller can surface a toast.
 *
 *   Phase 2 — commit writes: execute each planned write, catching per-write
 *   failures locally so the loop reaches every file before reporting. A
 *   planned note renamed meanwhile is written at its new path; one that is
 *   simply gone keeps the sentinel and is named in a toast.
 *
 * Splitting the phases lets `fileTagsStore.renameTagEverywhere` /
 * `removeTagEverywhere` decide whether to commit their `.filo/tags.json`
 * + tile-def cascade based on the outcome — if any `.md` write failed,
 * the registry stays at the old name so a retry naturally targets only
 * the unwritten files (the metadata of the succeeded files no longer
 * mentions the old tag).
 *
 * Lives in `lib/vault/` (not `stores/`) to keep the heavy logic out of the
 * already-large fileTagsStore module. Each write goes through the note store,
 * which rewrites the note from its fresh bytes inside its own write queue.
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
import { uiStore } from '../../stores/ui.svelte';
import { PendingWritesFailedError, withDrainedWrites } from './vaultOperations';
import { noteStore } from '../../stores/notes.svelte';
import { isMissingFileError, NoteBusyError } from '../notes/noteWriter';
import { isLinkedNote, isNonUtf8 } from './nonUtf8Paths.svelte';
import { getActiveVaultPath } from './activeVaultPath';
import type { FileMetadata } from './vaultIndex';
import { rebasePath, registerPathRenamable } from './renamePathKeys';

/**
 * Full-function mutex. Two rapid tag renames (`#draft` → `#review`, then
 * `#review` → `#final`) could otherwise interleave per-file write IPCs, and
 * whichever the OS scheduled last wins — possibly the OLDER rename's rewrite.
 * Serialising whole sweeps costs throughput, but a per-path lock map isn't
 * worth it for a human-cadence operation.
 *
 * Reset on vault swap so a straggling sweep tied to the outgoing vault
 * doesn't block the new vault's first sweep — the new vault's metadata
 * doesn't share file paths with the old, so the in-flight chain has no
 * coherent way to wait for it.
 */
let sweepInflight: Promise<MarkdownRewriteResult> | null = null;

/**
 * Renames seen while a sweep runs (sweeps are serialised, so at most one
 * list), in order. A planned note that moved meanwhile is rewritten where it
 * is now instead of being taken for deleted.
 */
let sweepRenames: Array<[string, string]> | null = null;

registerPathRenamable('tagRewriteSweep', (oldRel, newRel) => {
  sweepRenames?.push([oldRel, newRel]);
});

onVaultSwap('pre-swap', 'tagRewriteSweep', () => {
  sweepInflight = null;
  sweepRenames = null;
});

/** Where `path` is after the renames recorded so far, or null if none touched it. */
function movedTo(path: string): string | null {
  let now = path;
  for (const [oldRel, newRel] of sweepRenames ?? []) now = rebasePath(now, oldRel, newRel) ?? now;
  return now === path ? null : now;
}

/** Test-only — drops the in-memory sweep mutex chain. */
export function __resetTagRewriteSweepForTests(): void {
  sweepInflight = null;
  sweepRenames = null;
}

/**
 * Aggregate result of a sweep. `attempted` counts files whose frontmatter
 * genuinely needed rewriting (deduped against the `next === raw`
 * short-circuit); `succeeded` lists paths that hit disk; `failed` lists
 * paths whose read or write raised an error.
 *
 * A file already gone at the scan is dropped (the index was behind). A
 * planned file gone by the time its write runs, and not moved by a rename
 * seen during the sweep, is listed in `skippedMissing`: it doesn't block the
 * caller's commit, but it keeps the sentinel and is named in a toast.
 */
export interface MarkdownRewriteResult {
  attempted: number;
  succeeded: string[];
  failed: string[];
  skippedMissing?: string[];
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
 * The full sweep is serialised through `sweepInflight` (see above).
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
  sweepRenames = [];
  try {
    return await runSweepRecordingRenames(args);
  } finally {
    sweepRenames = null;
  }
}

async function runSweepRecordingRenames(args: TagRewriteSweepArgs): Promise<MarkdownRewriteResult> {
  const { vaultRoot, metadata, oldName, newName, applyChanges, pathFilter } = args;
  if (!vaultRoot) return { attempted: 0, succeeded: [], failed: [] };

  // The plan holds only PATHS; the rewritten bytes are recomputed from a fresh
  // re-read inside the post-drain commit loop, so they can't go stale against an
  // editor body the drain later flushes. Phase 1 still computes `next` locally
  // for the `next === raw` dedup that decides whether a file needs rewriting.
  const plan: Array<{ path: string }> = [];
  const failed: string[] = [];
  // Notes whose bytes aren't UTF-8: rewriting them from the
  // decoded text would persist U+FFFD for every non-ASCII byte, so they are
  // skipped (and main refuses the write anyway) and named in one toast.
  const skippedNonUtf8: string[] = [];
  const skippedLinks: string[] = [];
  // Planned notes gone by the time their write ran, with no recorded rename
  // to follow: named in a toast, and the sentinel stays.
  const skippedMissing: string[] = [];

  for (const md of metadata) {
    // Case-insensitive match: the index preserves the file's authored casing
    // (`Project`) while the registry canonical may be `project`.
    if (!md.tags.some((t) => tagsEqual(t, oldName))) continue;
    if (pathFilter && !pathFilter.has(md.path)) continue;

    let raw: string | null = null;
    try {
      const readResult = await invokeOk('vault:read-file-text', vaultRoot, md.path);
      if (readResult.encoding === 'invalid-utf-8') {
        skippedNonUtf8.push(md.path);
        continue;
      }
      if (readResult.link) {
        skippedLinks.push(md.path);
        continue;
      }
      raw = readResult.content;
    } catch (err) {
      // Envelope failure (file deleted between scan + read, EACCES, …)
      // is distinguished from a non-envelope throw (programmer error,
      // out of memory) so we keep "file vanished → silently drop, file
      // present → record failure" semantics.
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

  // Lay down the recovery sentinel BEFORE Phase 2 so a crash mid-write leaves
  // a resume breadcrumb. The tag rewriter is idempotent, so a Resume on next
  // open re-runs the sweep safely. Sentinel-write failure aborts the rewrite —
  // better to refuse than commit writes without a breadcrumb. The payload is
  // kept live so the removal path can re-write it with `committedPaths`
  // progress as each .md is stripped.
  const sentinelPayload: TagRewriteSentinelPayload = {
    timestamp: Date.now(),
    oldName,
    newName,
    plan: plan.map((p) => p.path),
    // Snapshot files that ALREADY carry `newName` before the
    // sweep touches disk (a merge-rename into an existing tag, or files
    // the user independently tagged). Partial-state detection excludes
    // these so recovery doesn't falsely flag "some files already rewritten"
    // on every open. Empty for removals.
    preexistingNewNamePaths:
      newName === null
        ? []
        : metadata.filter((m) => m.tags.includes(newName)).map((m) => m.path),
    // Filled incrementally below (removals only).
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

  // Drain pending writers BEFORE the Phase 2 commit loop: a debounced editor
  // write armed against a planned path would otherwise fire AFTER our rewrite
  // and overwrite it with the editor's pre-rename body.
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
        // The note writer writes into whichever vault is open. After a swap the
        // planned paths belong to the previous vault: stop, and leave the rest
        // failed (the sentinel resumes them there).
        if (getActiveVaultPath() !== vaultRoot) {
          failed.push(item.path);
          continue;
        }
        try {
          // Recompute the rewrite from the note's fresh bytes inside its queue
          // (after anything queued for it, including an editor body, has
          // landed), never from the Phase-1 snapshot. Tag rewrites edit EXISTING
          // files: a file gone since the scan throws ENOENT instead of being
          // resurrected. If a rename recorded during the sweep moved it, the
          // rewrite follows it there. An open view of the note follows the new
          // bytes and keeps any keystrokes typed meanwhile. `notifyOnError:
          // false` avoids one toast per file; the caller shows an aggregate
          // retry toast.
          let target = item.path;
          let written: string | null | undefined;
          while (written === undefined) {
            try {
              written = await noteStore.transform(
                target,
                (fresh) => (newName === null
                  ? removeTagFromMarkdown(fresh.raw, oldName)
                  : rewriteTagInMarkdown(fresh.raw, oldName, newName)),
                { notifyOnError: false },
              );
            } catch (err) {
              if (!isMissingFileError(err)) throw err;
              const now = movedTo(item.path);
              if (now === null || now === target) break;
              target = now;
            }
          }
          if (written === undefined) {
            skippedMissing.push(item.path);
            continue;
          }
          if (written === null) {
            // Already without the old tag, no longer UTF-8 (never rewritten
            // from decoded text), or a symbolic link (never replaced).
            if (isNonUtf8(target)) skippedNonUtf8.push(target);
            else if (isLinkedNote(target)) skippedLinks.push(target);
            continue;
          }
          succeeded.push(target);
          // For REMOVALS, persist the per-path commit breadcrumb
          // incrementally so a crash mid-sweep leaves the partial state
          // detectable on reopen (renames detect partial state from the index
          // and skip this extra write). The breadcrumb write is best-effort:
          // the .md strip already landed, so a failed breadcrumb only risks a
          // committedPaths list short by one — harmless, because recovery
          // converges forward idempotently regardless of the exact list.
          if (newName === null) {
            sentinelPayload.committedPaths.push(target);
            try {
              await writePendingRewrite(vaultRoot, sentinelPayload);
            } catch (breadcrumbErr) {
              reportError(
                'tagRewriteSweep',
                breadcrumbErr,
                `Failed to update tag-removal progress breadcrumb after ${target}`,
              );
            }
          }
        } catch (err) {
          // A note with an edit that can't be saved yet is left for the
          // retry; the caller's toast names it with the other failures.
          if (!(err instanceof NoteBusyError)) reportError('tagRewriteSweep', err, `Failed to rewrite tag in ${item.path}`);
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
  if (skippedNonUtf8.length > 0) {
    const names = skippedNonUtf8.slice(0, 5).join(', ') + (skippedNonUtf8.length > 5 ? `, +${skippedNonUtf8.length - 5} more` : '');
    uiStore.pushToast({
      text: `Tag rename skipped ${skippedNonUtf8.length} note${skippedNonUtf8.length === 1 ? '' : 's'} that aren't UTF-8 (converting them would damage accented characters): ${names}. Open each and use "Convert to UTF-8" first.`,
      type: 'warning',
      duration: 12000,
    });
  }
  if (skippedLinks.length > 0) {
    const names = skippedLinks.slice(0, 5).join(', ') + (skippedLinks.length > 5 ? `, +${skippedLinks.length - 5} more` : '');
    uiStore.pushToast({
      text: `Tag ${newName === null ? 'removal' : 'rename'} skipped ${skippedLinks.length} note${skippedLinks.length === 1 ? '' : 's'} that ${skippedLinks.length === 1 ? 'is a link' : 'are links'} to another file: ${names}. Edit the original${skippedLinks.length === 1 ? '' : 's'}.`,
      type: 'warning',
      duration: 12000,
    });
  }
  if (skippedMissing.length > 0) {
    const names = skippedMissing.slice(0, 5).join(', ') + (skippedMissing.length > 5 ? `, +${skippedMissing.length - 5} more` : '');
    uiStore.pushToast({
      text: `Tag ${newName === null ? 'removal' : 'rename'} skipped ${skippedMissing.length} note${skippedMissing.length === 1 ? '' : 's'} that could no longer be found: ${names}. Filo will offer to finish it the next time this vault opens.`,
      type: 'warning',
      duration: 12000,
    });
  }

  // Only clear the sentinel when EVERY planned path succeeded; a note that
  // went missing counts as not done. Otherwise we leave it so the next vault
  // open can replay the rewrite via the recovery prompt (idempotent —
  // already-rewritten files are no-ops).
  //
  // The caller's retry toast in fileTagsStore still re-lays a fresh
  // sentinel covering just the still-failed paths when the user clicks
  // "Retry" inside the session; the next-open recovery is the safety
  // net for users who close the app before the toast retry fires.
  if (plan.length > 0 && failed.length === 0 && skippedMissing.length === 0) {
    await clearPendingRewrite(vaultRoot);
  }

  return { attempted: plan.length + failed.length, succeeded, failed, skippedMissing };
}
