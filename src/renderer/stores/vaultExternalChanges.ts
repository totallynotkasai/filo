import { vaultIndexStore } from './vaultIndex.svelte';
import { noteStore } from './notes.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { uiStore } from './ui.svelte';
import { reportError } from '../lib/utils/errorBus';
import { getBaseline, hasBaselineDrifted } from '../lib/vault/fileBaselineRegistry';
import {
  writePendingRenameCascade,
  clearPendingRenameCascade,
  markRenameCascadeFlushFailed,
} from '../lib/vault/renameCascadeSentinel';
import { PendingWritesFailedError, withDrainedWrites } from '../lib/vault/vaultOperations';
import { renameAllPathKeys } from '../lib/vault/renamePathKeys';
import {
  captureVaultIdentity,
  isStillSameVault,
  type VaultIdentity,
} from '../lib/vault/vaultIdentity';
import type { VaultContext } from './vaultStoreTypes';
import { onVaultSwap } from '../core/vaultLifecycle';
import {
  noteRecentRename,
  wasRecentlyRenamed,
  clearRecentRenames,
  ATTACHMENT_DELETE_GRACE_MS,
  reappearanceWindowRemaining,
} from '../lib/vault/externalChangeWindows';
import {
  promptExternalAttachmentDeleted,
  promptClosedBoardFileMissing,
} from './vaultExternalPrompts';

/**
 * Vault slice — external-edit pipeline. A changed note refreshes the vault
 * index and, when a view holds it, its note model (`noteStore.onDiskChanged`
 * decides per the C.5 table). Deletes offer to remove tiles that point at the
 * file; renames re-key every path-keyed piece of state.
 *
 * The partial-read retry bookkeeping and the attachment-delete grace window
 * (module-scoped timing state + their reset helpers) live in
 * `../lib/vault/externalChangeWindows`; their reset helpers are re-exported
 * below for existing import sites (tests).
 */

export {
  _resetAttachmentDeleteGraceForTests,
} from '../lib/vault/externalChangeWindows';

/**
 * Tiebreak for a path inside the self-write suppression window. Returns true
 * when a fresh disk stat diverges from the baseline Filo last wrote (mtime OR
 * size) — a real external editor touched the file after our write, so it must
 * NOT be dropped as our own echo. Returns false (drop it) when there's no
 * baseline, the stat is unavailable, or it matches — the data-safe direction:
 * worst case is waiting for the 30s reconcile, never a spurious prompt.
 * Shared with the `.board.json` reconciler.
 */
export async function selfWriteDivergedFromBaseline(root: string, rel: string): Promise<boolean> {
  const baseline = getBaseline(rel);
  if (!baseline) return false;
  try {
    const stat = await window.filo.invoke('vault:stat', root, rel);
    if (!stat || stat.success !== true) return false;
    return hasBaselineDrifted(baseline, { mtimeMs: stat.mtimeMs, size: stat.size });
  } catch {
    return false;
  }
}

/**
 * While a sync conflict's original is expected to reappear
 * (`noteExpectedReappearance`, set by the `vault:sync-conflict` notice), a
 * "deleted externally" prompt for it is postponed to the end of the window and
 * shown only if the file is STILL missing then. Returns true when deferred.
 */
function deferWhileReappearing(rel: string, identity: VaultIdentity, prompt: () => void): boolean {
  const wait = reappearanceWindowRemaining(rel);
  if (wait <= 0) return false;
  const promptIfStillMissing = async (): Promise<void> => {
    if (!isStillSameVault(identity)) return;
    let back = false;
    try {
      back = (await window.filo.invoke('vault:file-exists', identity.path, rel)) === true;
    } catch {
      back = false;
    }
    if (isStillSameVault(identity) && !back) prompt();
  };
  // A one-shot re-check, not a debounced write (no scheduler involvement).
  setTimeout(promptIfStillMissing, wait + 250);
  return true;
}

export function makeExternalChangesSlice(ctx: VaultContext) {
  return {
    async handleExternalMarkdownChanges(relPaths: string[]): Promise<void> {
      // Capture vault identity before the first await so the guards below can
      // bail on a swap; otherwise this vault's decisions would apply to the
      // new vault's same-named file.
      const identity = captureVaultIdentity();
      if (relPaths.length === 0) return;
      // A full index rebuild clears the index then re-reads in chunks; wait so
      // the refresh below lands on the rebuilt index.
      if (vaultIndexStore.isBuilding) {
        await vaultIndexStore.whenBuildComplete();
      }
      // The index is a projection of disk: refresh it for every change. Our
      // own writes coming back re-index to the same metadata.
      await vaultIndexStore.applyChanges(relPaths);
      if (!isStillSameVault(identity)) return;

      for (const rel of relPaths) {
        const next = vaultIndexStore.getMetadata(rel);
        const note = noteStore.get(rel);
        // The file is back on disk (sync re-created it, a move landed, trash
        // restore): a still-visible "missing" / "deleted externally" toast
        // for it is stale and must not stay clickable.
        if (next) {
          uiStore.dismissToastsByKey(`missing:${rel}`, { silent: true });
          uiStore.dismissToastsByKey(`ext-deleted:${rel}`, { silent: true });
        }
        // A loaded note decides for itself: our own write coming back is
        // ignored by hash, a clean note follows the disk, and the one prompt
        // appears only when an unsaved body meets a body change on disk.
        if (note) void noteStore.onDiskChanged(rel);
        if (next) continue;
        // Deleted, and tiles still point at it: offer "Keep tiles" / "Remove
        // tiles…" (removal only behind a confirm). No auto-clean: the user
        // might be moving the file and the rename correlator may still pair
        // it. A note with an unsaved edit gets its own prompt instead.
        if (note?.hasUnsavedBody) continue;
        const targets = boardCacheStore.findCascadeDeleteTargets(rel);
        if (targets.tileIds.length > 0) {
          const root = ctx.getVaultPath();
          const prompt = (): void => promptClosedBoardFileMissing(rel, targets.tileIds.length, root);
          if (!deferWhileReappearing(rel, identity, prompt)) prompt();
        }
      }
    },

    /**
     * External rename handler. Funnelled here from the
     * `vault:file-renamed` watcher event so concurrent renames serialise
     * through the shared promise chain in `vault.svelte.ts`. Mirrors the
     * full in-app rename follow-up sequence so an external move (git mv,
     * sync client, OS file-explorer drag) lands in the same final state
     * as a sidebar rename — minus the IPC call, which the OS already did:
     *
     *   1. Hydrate every board so a lazy-loaded entry isn't skipped.
     *   2. Rebind any moved `.board.json` cache key (renameBoardPath) so
     *      the subsequent tree-update reconcile doesn't see the old path
     *      as "missing" and evict the board.
     *   3. Propagate the rename across tile defs (boardStore.propagateRename
     *      walks FILE_REF_FIELDS — covers `file`/`src`/`filePath`/`coverImage`/
     *      `backgroundImage`, including text-tile filename via the
     *      `propagateMarkdownRenameToTextTiles` branch).
     *   4. Mirror into `.filo/tags.json` (file + folder helpers — both safe
     *      to call regardless of file/folder).
     *   5. Rebind any open `DocumentState.filename`.
     *   6. Propagate `activeRootFolder` (vault-wide pin) if it matched the
     *      old path. Without this the next autosave through
     *      `vault:write-file-text` resurrects the old folder via
     *      mkdir-recursive.
     *   7. Propagate per-board `defaultFolder` pins (same protection).
     *   8. Write a rename-cascade sentinel BEFORE the flush. A crash
     *      between propagateRename and the .board.json write surfaces a
     *      retry prompt on next vault open.
     *   9. Mark every renamed board dirty + flush the cache.
     *  10. On partial-flush failure: toast + mark sentinel with the failed
     *      board IDs. On full success: clear the sentinel.
     */
    async handleExternalRename(oldRel: string, newRel: string): Promise<void> {
      // Record that this oldPath was just renamed so a parallel
      // `handleExternalAttachmentChanges` for the same path (the watcher
      // can emit deleted-old + created-new events before the correlator
      // pairs them into a single rename event) can suppress its prompt.
      noteRecentRename(oldRel);

      // Capture the vault identity before the drain: a swap during it would
      // otherwise run the cascade against the new vault's cache with the old
      // rename's paths.
      const captured = captureVaultIdentity();
      // Root captured pre-drain for the drain-failure breadcrumb below.
      const preDrainVaultRoot = ctx.getVaultPath();

      // The file has already moved, so re-key every path-keyed piece of state
      // (note models and their write queues, tabs, undo history, baselines)
      // BEFORE the drain: a note's queued edit then lands in the moved file,
      // on the base it was built on, instead of failing on the old path.
      const pathKeysOk = renameAllPathKeys(oldRel, newRel);

      // Drain pending writers before the cascade, so the board and tag
      // rewrites below don't race a write still in flight.
      try {
        await withDrainedWrites(
          () => runExternalRenameCascade(ctx, oldRel, newRel, pathKeysOk, captured),
          { paths: [oldRel, newRel] },
        );
      } catch (err) {
        if (err instanceof PendingWritesFailedError) {
          // Drain toasted; skip the cascade so we don't propagate partial
          // state. The OS rename already happened and won't be re-synthesised,
          // so lay the rename-cascade sentinel for next-open recovery to
          // replay — otherwise the old path's attachment tags get pruned on
          // next open. `repairRenameCascade` recomputes the affected boards,
          // so empty `affectedBoardIds` suffices. Skipped on a vault swap.
          if (isStillSameVault(captured) && preDrainVaultRoot && oldRel && newRel) {
            try {
              await writePendingRenameCascade(preDrainVaultRoot, {
                oldPath: oldRel,
                newPath: newRel,
                affectedBoardIds: [],
              });
            } catch (sentinelErr) {
              reportError(
                'vault.handleRename.sentinel',
                sentinelErr,
                "Couldn't record a rename-recovery sentinel after the pre-rename flush failed — board references and attachment tags for the renamed file may need manual repair.",
              );
            }
          }
          return;
        }
        throw err;
      }
    },

    /**
     * External attachment delete handler. The watcher's
     * `vault:files-changed` channel surfaces `type: 'attachment'` events for
     * every uncorrelated image/video/audio/pdf change. Correlated cross-folder
     * moves are already routed through `vault:file-renamed` and propagated by
     * `handleRenameEvent` (which rewrites tile `src` / `filePath` /
     * `coverImage` / frame `backgroundImage` via `propagateRename`'s
     * FILE_REF_FIELDS scan). What remains here:
     *
     *  - Uncorrelated deletes (file gone, no rename pair) — surface a
     *    confirm toast and let the user cascade-delete the dependent
     *    placements via the existing undoable command. Mirrors the
     *    `prompt-closed-board-file-missing` flow for documents.
     *  - Uncorrelated creates / content changes — no action. Attachments
     *    have no body-sync pipeline; a content change to a referenced media
     *    file is invisible to the cache (the OS-level file is what the
     *    `filo://` protocol reads at render time).
     *
     * Note: this method intentionally does NOT consume `eventType`. The
     * watcher emits `'rename'` for both creates and deletes, so the only
     * reliable distinguisher is whether the file still exists on disk.
     */
    async handleExternalAttachmentChanges(relPaths: string[]): Promise<void> {
      const vaultRoot = ctx.getVaultPath();
      if (!vaultRoot) return;
      // Capture the generation-aware identity before the grace window, so a
      // swap (incl. close → reopen of the same path) drops the deferred prompt.
      const identity = captureVaultIdentity();
      // Defer the prompt by the grace window so a cross-folder
      // external move that the watcher hasn't yet correlated into a
      // synthetic rename event doesn't surface a spurious "deleted
      // externally" toast. After the wait we double-check whether the
      // renamer caught up (`wasRecentlyRenamed`) and whether the file
      // came back on disk; either suppresses the prompt. We `await`
      // every deferred decision so callers / tests can drive the
      // pipeline deterministically.
      const tasks = relPaths.map(async (rel) => {
        let exists = false;
        try {
          exists = await window.filo.invoke('vault:file-exists', vaultRoot, rel);
        } catch {
          exists = false;
        }
        if (exists) return;
        const targets = boardCacheStore.findCascadeDeleteTargets(rel);
        if (targets.tileIds.length === 0) return;
        await new Promise((resolve) => setTimeout(resolve, ATTACHMENT_DELETE_GRACE_MS));
        // Vault swap during the grace window? Drop the prompt.
        if (!isStillSameVault(identity)) return;
        if (wasRecentlyRenamed(rel)) return;
        try {
          const stillExists = await window.filo.invoke('vault:file-exists', vaultRoot, rel);
          if (stillExists) return;
        } catch {
          // Treat probe failure as "still missing" — better to surface
          // the prompt than swallow the delete.
        }
        // Re-check tile targets — propagateRename may have rebound the
        // refs to the new path during the grace window so nothing dangles.
        const stillTargets = boardCacheStore.findCascadeDeleteTargets(rel);
        if (stillTargets.tileIds.length === 0) return;
        // Outer-scoped `vaultRoot` anchors the cascade;
        // the swap check earlier already returned if a swap happened.
        promptExternalAttachmentDeleted(rel, stillTargets.tileIds.length, vaultRoot);
      });
      await Promise.all(tasks);
    },
  };
}

/**
 * Runs the external-rename cascade inside `withDrainedWrites`.
 *
 * The cascade mirrors the in-app rename's post-IPC follow-up (renameBoardPath,
 * propagateRename, tags, doc filename, activeRootFolder, defaultFolder pins,
 * sentinel breadcrumb, flushAllDirty + failed-paths toast).
 *
 * `pathKeysOk` is false when a path-keyed sweep threw: the rename is then
 * recorded in the sentinel, and kept there, even if every write succeeds.
 */
async function runExternalRenameCascade(
  ctx: VaultContext,
  oldRel: string,
  newRel: string,
  pathKeysOk: boolean,
  captured?: VaultIdentity,
): Promise<void> {
  await boardCacheStore.ensureAllLoaded();
  // A vault swap during the drain or `ensureAllLoaded` would make the
  // synchronous cache mutations below corrupt the new vault's cache with the
  // old vault's rename paths. Bail if the vault changed.
  if (captured && !isStillSameVault(captured)) return;
  // The path-keyed sweeps (`renameAllPathKeys`) already ran in
  // `handleExternalRename`, before the drain.
  const renamedBoardIds = boardCacheStore.renameBoardPath(oldRel, newRel);
  const changedBoardIds = boardStore.propagateRename(oldRel, newRel);
  fileTagsStore.renameFile(oldRel, newRel);
  fileTagsStore.renameFolder(oldRel, newRel);
  // Lay the rename-cascade breadcrumb against the outgoing vault root HERE,
  // before the tag-flush await and its swap bail: propagateRename already
  // mutated the in-memory cache, so a swap during the flush would otherwise
  // abandon the cascade with no retry. Only when a board was touched — the
  // later edits run after the bail. The no-swap path reuses this id below.
  const vaultRoot = ctx.getVaultPath();
  let sentinelId: string | null = null;
  if (
    (changedBoardIds.length > 0 || renamedBoardIds.length > 0) &&
    vaultRoot &&
    oldRel &&
    newRel
  ) {
    try {
      sentinelId = await writePendingRenameCascade(vaultRoot, {
        oldPath: oldRel,
        newPath: newRel,
        // Include renamed boards (own .board.json moved), not just
        // reference-changed boards, so the breadcrumb names the full set.
        affectedBoardIds: [...new Set([...changedBoardIds, ...renamedBoardIds])],
      });
    } catch (err) {
      reportError(
        'vault.handleRename.sentinel',
        err,
        "Couldn't record a rename-recovery sentinel for the external rename — the cascade will proceed without crash protection",
      );
    }
  }
  // Persist the tag-membership rename now rather than on the misc debounce: a
  // crash after the board flush below but before that debounce would leave
  // `.filo/tags.json` keyed by the old path. Done before the `hasCascadeWork`
  // early-return so a tags-only rename is covered too.
  //
  // A failure must not abort the rest of the cascade (board flush + recovery
  // sentinel). `flushPendingSave` resolves `{ ok: false }` on a write failure
  // and only throws on a synchronous getArgs failure; both mark it failed.
  let tagsFlushOk = true;
  try {
    const tagsFlush = await fileTagsStore.flushPendingSave();
    tagsFlushOk = tagsFlush.ok;
  } catch (err) {
    tagsFlushOk = false;
    reportError(
      'vault.handleRename.tagsFlush',
      err,
      "Couldn't persist the tag-membership rename during the external rename; the recovery sentinel will re-assert it on next vault open.",
    );
  }
  // Re-check after the flush await: a swap there means the mutations below
  // would corrupt the new vault with the old rename paths. The breadcrumb is
  // already written against the outgoing `vaultRoot`.
  if (captured && !isStillSameVault(captured)) return;
  // Rebind vault search to the new path immediately.
  // Exact-match handles the file-rename case; the loop handles the
  // folder-rename case where indexed descendants live under the moved
  // prefix.
  vaultIndexStore.renameKey(oldRel, newRel);
  const childPrefix = oldRel.endsWith('/') ? oldRel : oldRel + '/';
  for (const md of vaultIndexStore.allMetadata()) {
    const path = md.path;
    if (path.startsWith(childPrefix)) {
      vaultIndexStore.renameKey(path, newRel + path.slice(oldRel.length));
    }
  }
  const project = ctx.getProject();
  if (project?.settings.general) {
    const currentRoot = project.settings.general.activeRootFolder ?? '';
    if (currentRoot === oldRel || currentRoot.startsWith(oldRel + '/')) {
      const suffix = currentRoot.slice(oldRel.length);
      project.settings.general.activeRootFolder = newRel + suffix;
      ctx.markMetaDirty();
    }
  }
  const defaultFolderBoardIds = boardStore.clearBoardDefaultFolderIfMatches(oldRel, newRel);

  for (const boardId of renamedBoardIds) {
    boardCacheStore.markDirty(boardId);
  }

  // Skip the sentinel write entirely when the cascade touched nothing. Three
  // independent signals contribute:
  //
  //  - propagateRename's `changedBoardIds` — boards whose tile defs
  //    referenced the renamed file (text-tile filename, image src,
  //    coverImage, frame backgroundImage, etc.).
  //  - renameBoardPath's `renamedBoardIds` — boards whose own
  //    `.board.json` file moved.
  //  - clearBoardDefaultFolderIfMatches's `defaultFolderBoardIds` —
  //    boards whose per-board `defaultFolder` pin matched the old
  //    path (rewrites mark those boards dirty via the cache).
  //
  // When all three are empty there's no cascade state to recover, so a
  // sentinel would be pure noise (typically an in-app rename's watcher echo
  // that survived suppression).
  //
  // The activeRootFolder rewrite above is a project-level change
  // — `markMetaDirty` handles the persist on its own; the
  // sentinel guards board cascade only, so we still skip when
  // it's the lone change.
  const hasCascadeWork =
    changedBoardIds.length > 0 ||
    renamedBoardIds.length > 0 ||
    defaultFolderBoardIds.length > 0;
  if (!hasCascadeWork) {
    // If the tag flush above failed (or a path-keyed sweep threw), there is no
    // board cascade to carry a recovery sentinel. Lay down a minimal one so
    // reopen replays the rename (`renameCascadeRepair` always re-asserts
    // tags.json keys and the path-keyed sweeps, independently of
    // `affectedBoardIds`).
    if ((!tagsFlushOk || !pathKeysOk) && vaultRoot && oldRel && newRel) {
      try {
        await writePendingRenameCascade(vaultRoot, {
          oldPath: oldRel,
          newPath: newRel,
          affectedBoardIds: [],
        });
      } catch (err) {
        reportError(
          'vault.handleRename.tagsOnlySentinel',
          err,
          "Couldn't record a tags-only rename-recovery sentinel; if the tag-membership rename didn't persist you may need to re-apply it.",
        );
      }
    }
    // Nothing else to flush and no board sentinel to clear. Bail before the
    // sentinel write + flushAllDirty pair.
    return;
  }

  // Write the board-cascade sentinel here only if the early breadcrumb wasn't
  // laid down — i.e. only the defaultFolder pin changed (computed after the
  // bail, so it can't appear in the early breadcrumb).
  if (sentinelId === null && vaultRoot && oldRel && newRel) {
    try {
      sentinelId = await writePendingRenameCascade(vaultRoot, {
        oldPath: oldRel,
        newPath: newRel,
        affectedBoardIds: [...changedBoardIds],
      });
    } catch (err) {
      reportError(
        'vault.handleRename.sentinel',
        err,
        "Couldn't record a rename-recovery sentinel for the external rename — the cascade will proceed without crash protection",
      );
    }
  }

  const flushResult = await boardCacheStore.flushAllDirty();
  if (flushResult.failed.length > 0) {
    uiStore.pushToast({
      text: `External rename propagated, but failed to update ${flushResult.failed.length} board file${flushResult.failed.length === 1 ? '' : 's'}: ${flushResult.failed.join(', ')}. Re-save the affected boards.`,
      type: 'error',
      duration: 0,
    });
    if (vaultRoot && sentinelId) {
      await markRenameCascadeFlushFailed(
        vaultRoot,
        sentinelId,
        flushResult.failed.slice(),
      ).catch((err) => {
        reportError(
          'vault.handleRename.sentinel',
          err,
          "Couldn't update rename-cascade sentinel with failed paths",
        );
      });
    }
  } else if (vaultRoot && sentinelId && pathKeysOk) {
    await clearPendingRenameCascade(vaultRoot, sentinelId).catch((err) => {
      reportError(
        'vault.handleRename.sentinel',
        err,
        "Couldn't clear completed rename-cascade sentinel",
      );
    });
  }
}

// Vault-swap reset: drops the recent-rename grace map, else a same-named file in the new vault could be
// deduped by a stale entry from the prior vault. The subscriber name
// `'vaultExternalChanges'` is asserted by a characterization test.
onVaultSwap('pre-swap', 'vaultExternalChanges', () => {
  clearRecentRenames();
});

