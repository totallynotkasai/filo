import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { uiStore } from './ui.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { computeMoveIntoFolderTarget } from '../lib/vault/moveIntoFolder';
import { toVaultRelative } from '../lib/vault/vaultTreeSort';
import { cancelBoardWrite } from '../lib/boards/boardSaver';
import { markRecentSelfWrite } from '../lib/boards/writeStateTracking';
import { reportError } from '../lib/utils/errorBus';
import { normalizePath, stripLeadingSlash } from '../lib/utils/path';
import {
  writePendingRenameCascade,
  clearPendingRenameCascade,
  markRenameCascadeFlushFailed,
} from '../lib/vault/renameCascadeSentinel';
import { renameAllPathKeys } from '../lib/vault/renamePathKeys';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { beginRenameInFlight, endRenameInFlight } from '../lib/vault/renameInFlight';
import {
  PendingWritesFailedError,
  createVaultFolder,
  renameVaultPath,
  withDrainedWrites,
} from '../lib/vault/vaultOperations';
import { performDelete } from './vaultDeleteOps';
import type { V7BoardFileData } from '../lib/boards/boardSaver';
import type { VaultContext } from './vaultStoreTypes';

export type VaultRenameResult = {
  success: boolean;
  // `INVALID_FILENAME` surfaces an assertSafeFilename rejection (Windows
  // reserved name, control chars, ..) so the toast can name the rule.
  // `ENOSPC` distinguishes disk-full (and EIO/ENOMEM) so the toast can
  // prompt the user to free space rather than retry.
  // `TARGET_EXISTS` lets the caller offer a confirm prompt rather than
  // silently clobbering an existing destination on POSIX.
  code?: 'ENOENT' | 'EACCES' | 'IO_ERROR' | 'INVALID_FILENAME' | 'ENOSPC' | 'TARGET_EXISTS';
  // Populated only when a Windows case-only rename trampoline left the file stranded under its temp
  // name because every retry and the rescue restore failed. Carries
  // the absolute path the file ended up at so the rename-failure toast
  // can name it.
  strandedAt?: string;
};

/**
 * Typed result for `moveIntoFolder`, so the sidebar drop handlers can tell
 * "destination name already in use" from "permission denied" / "couldn't
 * talk to disk" / a no-op. Each variant drives a different toast (or none
 * for `ok: true`).
 *
 * `ok: true` with `newPath === sourcePath` indicates a no-op — the file
 * was already a direct child of the target folder, or the user dropped
 * onto an invalid target (self / descendant). Callers should still treat
 * these as success (no toast) so an accidental drop isn't surfaced as
 * an error.
 *
 * `code` is the high-level bucket the caller surfaces to the user.
 * The full `VaultRenameResult.code` from the underlying IPC is preserved
 * via `reason` for logging / detailed diagnostics, but the toast text
 * is keyed off `code`.
 */
export type MoveIntoFolderResult =
  | { ok: true; newPath: string }
  | {
      ok: false;
      code: 'TARGET_EXISTS' | 'PERMISSION_DENIED' | 'OTHER';
      reason?: VaultRenameResult['code'];
    };

function mapRenameCodeToMoveCode(
  code: VaultRenameResult['code'] | undefined,
): 'TARGET_EXISTS' | 'PERMISSION_DENIED' | 'OTHER' {
  if (code === 'TARGET_EXISTS') return 'TARGET_EXISTS';
  if (code === 'EACCES') return 'PERMISSION_DENIED';
  return 'OTHER';
}

/**
 * Folder-aware vault-index rename helper. Rebinds the
 * exact-match key for the renamed path and every indexed descendant whose
 * key sits under `oldRel + '/'`. No-op for non-markdown files, which the
 * index doesn't track in the first place.
 *
 * Exported for tests. The VaultIndex keys and the derived `oldKey` are both
 * case-PRESERVED, so the `startsWith` match holds for uppercase-named folders.
 */
export function renameVaultIndexUnderPrefix(oldRel: string, newRel: string): void {
  const oldKey = normalizePath(stripLeadingSlash(oldRel));
  const newKey = normalizePath(stripLeadingSlash(newRel));
  if (!oldKey || !newKey || oldKey === newKey) return;
  vaultIndexStore.renameKey(oldKey, newKey);
  const childPrefix = oldKey + '/';
  for (const md of vaultIndexStore.allMetadata()) {
    const path = md.path;
    if (path.startsWith(childPrefix)) {
      vaultIndexStore.renameKey(path, newKey + path.slice(oldKey.length));
    }
  }
}

/**
 * Vault slice — folder / file operations exposed to the sidebar (create,
 * rename, delete, move-into-folder, suggest-name). Each method delegates the
 * filesystem mutation to the main process via `window.filo.invoke`, then
 * runs the in-memory cascade (broken refs, active root folder, file refs).
 */
export function makeFolderOpsSlice(ctx: VaultContext) {
  return {
    async createFolder(
      parentPath: string,
      folderName: string,
    ): Promise<{ success: boolean; code?: string; error?: string }> {
      const fullPath = `${parentPath}/${folderName}`;
      const vaultRoot = ctx.getVaultPath();
      // Route through vaultOperations so the create races a clean
      // disk: any in-flight `.md` / `.board.json` / frontmatter write whose
      // target path lives under `fullPath` flushes before the `mkdir`.
      try {
        const result = await createVaultFolder(vaultRoot, fullPath);
        if (result.success) await ctx.refreshTree();
        return result;
      } catch (err) {
        if (err instanceof PendingWritesFailedError) {
          return { success: false, code: 'IO_ERROR', error: 'pending writes failed' };
        }
        throw err;
      }
    },

    async suggestFolderName(parentPath: string, baseName: string): Promise<string> {
      try {
        const vaultRoot = ctx.getVaultPath();
        if (!vaultRoot) return baseName;
        const result = await window.filo.invoke(
          'vault:suggest-folder-name', vaultRoot, parentPath, baseName,
        );
        return result.success && result.name ? result.name : baseName;
      } catch (err) {
        console.warn('[vault] suggestFolderName failed:', err);
        return baseName;
      }
    },

    async rename(oldPath: string, newPath: string): Promise<VaultRenameResult> {
      const vaultPath = ctx.getVaultPath();
      const oldRel = toVaultRelative(oldPath, vaultPath);
      const newRel = toVaultRelative(newPath, vaultPath);

      // Wrap the entire rename sequence (in-memory cascade + IPC + post-IPC
      // cascade) in `withDrainedWrites` so every writer pipeline (editor,
      // frontmatter, board) drains BEFORE the cascade snapshots the cache.
      //
      // Flag the rename in flight across the WHOLE sequence
      // (drain + in-memory cascade + IPC + any failure revert). `runRename`
      // rebinds the board cache to the new path before the rename IPC lands, so
      // for that window a watcher reconcile would see the path missing on disk
      // and evict the live board. `refreshTreeAndCleanup` checks
      // `isRenameInFlight()` and defers eviction. See renameInFlight.ts.
      beginRenameInFlight();
      try {
        return await withDrainedWrites(() =>
          runRename(ctx, vaultPath, oldPath, newPath, oldRel, newRel),
        );
      } catch (err) {
        if (err instanceof PendingWritesFailedError) {
          // The drain failure already pushed its own toast; surface a
          // generic IO_ERROR so the sidebar caller falls back to its
          // unchanged-state path instead of mistaking failure for success.
          return { success: false, code: 'IO_ERROR' };
        }
        throw err;
      } finally {
        endRenameInFlight();
      }
    },

    /**
     * Moves a file or folder into another folder (or the vault root). This is
     * how the Vault Sidebar's drag-and-drop nests files: we compose the new
     * absolute path and delegate to `rename`, so the existing rename cascade
     * (boardStore.propagateRename → fileRefIntegrity + refreshTree) runs.
     *
     * Refuses no-ops (already in target folder), self-targets, and moving a
     * folder into one of its own descendants (which would orphan the move on
     * the filesystem and create a rename loop).
     */
    async moveIntoFolder(
      sourcePath: string,
      folderPath: string,
    ): Promise<MoveIntoFolderResult> {
      const newPath = computeMoveIntoFolderTarget(sourcePath, folderPath);
      // No-op cases (already-in-target, self-target, moving
      // into own descendant) return a positive result so callers don't toast
      // an "error" for a deliberate drop on an inert target.
      if (!newPath) return { ok: true, newPath: sourcePath };
      const result = await this.rename(sourcePath, newPath);
      if (result.success) return { ok: true, newPath };
      return {
        ok: false,
        code: mapRenameCodeToMoveCode(result.code),
        reason: result.code,
      };
    },

    async delete(itemPath: string): Promise<boolean> {
      return performDelete(ctx, itemPath);
    },
  };
}

// ── Rename helper ──
//
// Extracted so the rename body sits inside `withDrainedWrites` cleanly.
// Returns the same `VaultRenameResult` shape the sidebar caller expects.
async function runRename(
  ctx: VaultContext,
  vaultPath: string,
  oldPath: string,
  newPath: string,
  oldRel: string | null,
  newRel: string | null,
): Promise<VaultRenameResult> {
      // Run the in-memory cascade BEFORE the IPC rename, so a re-render between
      // the IPC and the post-IPC cascade can't observe a half-renamed state.
      // If the cascade itself throws, we refresh the tree as a recovery.
      //
      // Revert is snapshot-based: on IPC failure the pre-cascade cache snapshot
      // is restored unconditionally, and debounced board writes scheduled by
      // the forward cascade are cancelled (they captured renamed snapshots at
      // schedule time and would write them against the OLD on-disk path). The
      // active-board tile map is `$derived` from the cache, so it rewinds
      // automatically; only the spatial index needs `rehydrateSpatial`.
      //
      // Snapshot vault identity before the first await: if the vault swapped
      // mid-rename, re-applying `cacheSnapshot` (the OUTGOING vault's boards)
      // would corrupt the NEW vault's cache. `isStillSameVault` gates both
      // revert sites.
      const renameIdentity = captureVaultIdentity();
      let cascadeApplied = false;
      let cacheSnapshot: Record<string, V7BoardFileData> | null = null;
      let changedBoardIds: string[] = [];
      // Snapshot boardPaths before the rename so we can
      // revert the renameBoardPath mutation on IPC failure.
      let boardPathsSnapshot: Record<string, string> | null = null;
      let renamedBoardIds: string[] = [];
      if (oldRel && newRel) {
        try {
          // Hydrate every board before the cascade so a lazy-loaded (or
          // partial-load-failed) entry isn't silently skipped. Under normal
          // operation the cache is already fully hydrated at vault open, so
          // this is effectively free.
          await boardCacheStore.ensureAllLoaded();
          cacheSnapshot = JSON.parse(
            JSON.stringify(boardCacheStore.cache),
          ) as Record<string, V7BoardFileData>;
          boardPathsSnapshot = { ...boardCacheStore.paths };
          // Rebind any board whose .board.json (or whose
          // parent folder) just moved. Must run BEFORE propagateRename so
          // the cascade walks the cache with paths that match disk reality
          // — otherwise the subsequent vault:tree-updated listener in
          // vault.svelte.ts spots the still-old path as "missing" and
          // calls cleanupMissingBoard, evicting the renamed board from
          // the project.
          renamedBoardIds = boardCacheStore.renameBoardPath(oldRel, newRel);
          changedBoardIds = boardStore.propagateRename(oldRel, newRel);
          cascadeApplied = true;
        } catch (err) {
          // Catch BEFORE the sentinel write — if propagateRename throws,
          // we never reach the IPC rename and there's nothing to recover.
          // Cascade threw mid-mutation — restore the cache snapshot if we
          // managed to capture one before the throw.
          if (cacheSnapshot && isStillSameVault(renameIdentity)) {
            for (const id of changedBoardIds) {
              cancelBoardWrite(id, boardCacheStore.paths[id]);
            }
            boardCacheStore.replaceCache(cacheSnapshot);
            // Also unwind the boardPaths rebind so the cache and paths agree on
            // the OLD path after revert.
            if (boardPathsSnapshot) boardCacheStore.replacePaths(boardPathsSnapshot);
            // Derived tiles already snap back to the restored cache; just
            // rehydrate the spatial index so hit-testing matches.
            boardStore.rehydrateSpatial();
          }
          reportError(
            'vault.rename.cascade',
            err,
            'Failed to update tile references for rename — refreshing the file tree',
          );
          await ctx.refreshTree();
          return { success: false, code: 'IO_ERROR' };
        }
      }

      // Record the rename intent BEFORE the IPC. If the IPC
      // succeeds but the subsequent `.board.json` flush partially fails,
      // the sentinel lets the next vault open replay the cascade.
      //
      // Best-effort: if the sentinel write itself fails (rare — `.filo/`
      // is on the same disk as the vault), log and continue. The cascade
      // still runs, just without a recovery breadcrumb.
      let sentinelId: string | null = null;
      if (oldRel && newRel) {
        try {
          sentinelId = await writePendingRenameCascade(vaultPath, {
            oldPath: oldRel,
            newPath: newRel,
            // Record renamed boards (whose own .board.json moved)
            // alongside reference-changed boards so the breadcrumb names the
            // full affected set, regardless of how boards are rediscovered.
            affectedBoardIds: [...new Set([...changedBoardIds, ...renamedBoardIds])],
            // A file/folder rename always touches the tags.json sink
            // (idempotently re-asserted on recovery). Recorded so a crash in
            // the disk-rename → tag-flush window is fully recoverable, not
            // just the board half.
            tagsAffected: true,
          });
        } catch (err) {
          reportError(
            'vault.rename.sentinel',
            err,
            "Couldn't record a rename-recovery sentinel — the rename will proceed without crash protection",
          );
        }
      }

      // Register the impending rename in the
      // recent-self-write filter BEFORE the IPC fires, so the watcher echo
      // of the OS rename event (which crosses the rename boundary as a
      // missing + present pair, often after our own cascade has already
      // updated `.board.json`s) doesn't re-trigger the external-rename
      // handler against an operation we just performed.
      if (oldRel) markRecentSelfWrite(oldRel);
      if (newRel) markRecentSelfWrite(newRel);
      // The cast narrows `code?: string` to the tight `VaultRenameResult` enum.
      //
      // Route through `renameVaultPath` so the disk-shape IPC is the *only*
      // sanctioned site. The outer `withDrainedWrites`
      // already drained; this re-entrant call short-circuits its own
      // drain via the module-level guard.
      const result = (await renameVaultPath(vaultPath, oldPath, newPath)) as VaultRenameResult;
      if (!result.success) {
        // IPC failed — revert the in-memory cascade so the cache, the
        // sidebar tree, and the disk all agree on the OLD path again.
        if (cascadeApplied && cacheSnapshot && isStillSameVault(renameIdentity)) {
          // Cancel any debounced writes scheduled by the forward cascade
          // before restoring state. Each carries a schedule-time
          // snapshot of the renamed cache; if they fire after the restore,
          // they'd write renamed-state content to the OLD on-disk path
          // (because the IPC rename didn't happen) and re-corrupt the cache
          // on the next read.
          //
          // Skipped if the vault swapped during the IPC await: the pre-swap hook
          // already replaced the cache, so re-applying the OUTGOING vault's
          // snapshot would corrupt the new vault. The disk rename never landed.
          for (const id of changedBoardIds) {
            cancelBoardWrite(id, boardCacheStore.paths[id]);
          }
          boardCacheStore.replaceCache(cacheSnapshot);
          // Unwind boardPaths too.
          if (boardPathsSnapshot) boardCacheStore.replacePaths(boardPathsSnapshot);
          // Derived tiles snap back automatically; only the
          // spatial index needs an explicit rebuild.
          boardStore.rehydrateSpatial();
        }
        // Drop the sentinel: the disk file didn't move, so
        // the recovery breadcrumb has nothing to replay.
        if (sentinelId) {
          await clearPendingRenameCascade(vaultPath, sentinelId).catch((err) => {
            reportError('vault.rename.sentinel', err, "Couldn't clear stale rename-cascade sentinel");
          });
        }
        // Refresh the sidebar tree so directory state matches disk reality
        // (in case the IPC failure was a partial rename that moved some
        // entries but not others — refreshTree resyncs).
        await ctx.refreshTree();
        return result;
      }

      if (oldRel && newRel) {
        // Fire every registered relPath-keyed sweep (noteStore,
        // fileBaselineRegistry, inFlightDriftPrompts, …). Run BEFORE the peer
        // rename calls below so a throwing sweep can't be masked by a later
        // flush, and open notes move in the same critical section as the
        // peer state.
        // The peer calls (renameFile, renameKey, propagateRename, …) aren't
        // migrated to the registry; the gate's EXEMPT_OWNERS list documents them.
        renameAllPathKeys(oldRel, newRel);
        // Mirror the rename into `.filo/tags.json`. The exact-match call
        // covers the file-rename case (`Notes.md` → `Bar.md`) and the
        // folder-prefix call covers the folder-rename case (`Sub` → `New`,
        // which rewrites every `Sub/foo.md` key). The two helpers don't
        // overlap — a file's exact-match key never starts with `oldRel/`
        // and a folder never has an exact-match key — so calling both is
        // safe and avoids a "is this a folder?" tree lookup at the call
        // site.
        fileTagsStore.renameFile(oldRel, newRel);
        fileTagsStore.renameFolder(oldRel, newRel);
        // Persist the tag-membership rename synchronously
        // in the same critical section as the awaited board flush below.
        // Leaving it on the 300ms misc debounce means a crash between the
        // board flush and that debounce firing drops the tag rename:
        // `.filo/tags.json` keeps the OLD key while every `.board.json`
        // already points at the new one. A failed flush surfaces through the
        // misc-write error pipeline.
        //
        // Capture the flush outcome. `flushPendingSave` resolves
        // `{ ok:false }` on the realistic write-failure path (the misc
        // scheduler catches the IPC error internally) and only throws on the
        // narrow synchronous-getArgs path, so guard both. On failure we KEEP
        // the rename-cascade sentinel below (it already carries
        // `tagsAffected:true`) so the next vault open re-asserts the tag rename
        // — without this, the full-success branch would clear the sentinel and
        // a failed tag rename would be silently unrecoverable.
        let tagsFlushOk = true;
        try {
          const tagsFlush = await fileTagsStore.flushPendingSave();
          tagsFlushOk = tagsFlush.ok;
        } catch (err) {
          tagsFlushOk = false;
          reportError(
            'vault.rename.tagsFlush',
            err,
            "Couldn't persist the tag-membership rename; the recovery sentinel will re-assert it on next vault open.",
          );
        }
        // Rebind the vault-search index so global search
        // returns the new name immediately. Exact-match handles the
        // file-rename case; the folder-rename case rebinds every indexed
        // descendant whose key sits under the moved prefix.
        renameVaultIndexUnderPrefix(oldRel, newRel);
        // Open documents were re-keyed to the new path by the
        // renameAllPathKeys sweep above.

        // Propagate the rename into `activeRootFolder` if it pointed at the
        // renamed folder (or lived inside it). Without this, the next
        // text-tile autosave resolves through the stale path and resurrects
        // the old folder via `fs.mkdir(..., recursive)`.
        const project = ctx.getProject();
        if (project?.settings.general) {
          const currentRoot = project.settings.general.activeRootFolder ?? '';
          if (currentRoot === oldRel || currentRoot.startsWith(oldRel + '/')) {
            const suffix = currentRoot.slice(oldRel.length);
            project.settings.general.activeRootFolder = newRel + suffix;
            ctx.markMetaDirty();
          }
        }
        // Same propagation for per-board defaultFolder pins on every cached
        // board. Pass `newPath` so the helper rewrites the prefix instead of
        // clearing the pin.
        boardStore.clearBoardDefaultFolderIfMatches(oldPath, newPath);
        // Mark any rebound board dirty so the next debounced
        // write lands at the new on-disk path. Without this, the cache
        // entry mapped under the new path never persists and the next
        // restart re-reads the file from disk under a path that may not
        // match the in-memory paths map any more.
        for (const boardId of renamedBoardIds) {
          boardCacheStore.markDirty(boardId);
        }
        // Flush the propagation immediately. Without this the 300 ms
        // debounce can absorb a quick app close after a rename and lose
        // the entire cascade — the file is renamed on disk but every
        // `.board.json` still points at the old path until next save.
        const renameCascadeFlush = await boardCacheStore.flushAllDirty();
        if (renameCascadeFlush.failed.length > 0) {
          // Surface failed .board.json writes so the user
          // knows the rename succeeded on disk but the in-memory cascade
          // didn't fully persist. Without this toast, the user-visible
          // sidebar reflects the new name while one or more affected
          // `.board.json` files still point at the old path on disk —
          // the next session reload would catch it via recovery, but
          // mid-session there's no signal.
          uiStore.pushToast({
            text: `Rename succeeded but failed to update ${renameCascadeFlush.failed.length} board file${renameCascadeFlush.failed.length === 1 ? '' : 's'}: ${renameCascadeFlush.failed.join(', ')}. Re-save the affected boards.`,
            type: 'error',
            duration: 0,
          });
          // Annotate the sentinel with the failed board IDs.
          // Leaving the sentinel in place ensures the next vault open
          // surfaces a retry modal for exactly the boards that didn't
          // flush — the cascade is preserved across the crash window.
          if (sentinelId) {
            await markRenameCascadeFlushFailed(
              vaultPath,
              sentinelId,
              renameCascadeFlush.failed.slice(),
            ).catch((err) => {
              reportError('vault.rename.sentinel', err, "Couldn't update rename-cascade sentinel with failed paths");
            });
          }
        } else if (sentinelId && tagsFlushOk) {
          // Full success path: drop the sentinel so the recovery prompt
          // doesn't surface on next open. Gated on `tagsFlushOk`: if the board cascade flushed cleanly but the
          // tag-membership flush above FAILED, we deliberately leave the
          // sentinel (it carries `tagsAffected:true`) so the next vault open
          // re-asserts the tag rename. Recovery handles `tagsAffected`
          // idempotently and independently of the (already-flushed) board IDs.
          await clearPendingRenameCascade(vaultPath, sentinelId).catch((err) => {
            reportError('vault.rename.sentinel', err, "Couldn't clear completed rename-cascade sentinel");
          });
        }
      } else if (sentinelId) {
        // IPC succeeded but oldRel/newRel was empty (path
        // outside vault, shouldn't happen post-guard). Clear the
        // breadcrumb anyway so it doesn't surface a spurious retry.
        await clearPendingRenameCascade(vaultPath, sentinelId).catch(() => {});
      }
      // Viewport state is now keyed by boardId in `.filo/viewports.json` so
      // it survives a rename automatically — no companion file to chase.
      await ctx.refreshTree();
      ctx.clearSelection();
      return result;
}
