import { vaultPath, type VaultPath } from '../../shared/vaultPath';
import type { FileMetadata } from '../lib/vault/vaultIndex';
import { vaultIndexStore } from './vaultIndex.svelte';
import { documentStore } from './document.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { uiStore } from './ui.svelte';
import { classifyExternalChange } from '../lib/vault/conflictResolver';
import { reportError } from '../lib/utils/errorBus';
import { isPathPending, isRecentSelfWrite } from '../lib/boards/boardSaver';
import { noteBaseline, getBaseline, hasBaselineDrifted } from '../lib/vault/fileBaselineRegistry';
import { isPropertiesPopupDirty } from '../lib/vault/propertiesPopupTracker';
import { historyStore } from './history.svelte';
import {
  writePendingRenameCascade,
  clearPendingRenameCascade,
  markRenameCascadeFlushFailed,
} from '../lib/vault/renameCascadeSentinel';
import { PendingWritesFailedError, withDrainedWrites } from '../lib/vault/vaultOperations';
import { dropStaleSeededFrontmatterCache } from '../lib/vault/staleSeededFrontmatter';
import { renameAllPathKeys } from '../lib/vault/renamePathKeys';
import {
  captureVaultIdentity,
  isStillSameVault,
  type VaultIdentity,
} from '../lib/vault/vaultIdentity';
import type { VaultContext } from './vaultStoreTypes';
import { onVaultSwap } from '../core/vaultLifecycle';
import {
  PARTIAL_READ_MAX_RETRIES,
  isPartialReadRetryInflight,
  getPartialReadRetryCount,
  clearPartialReadRetryCount,
  schedulePartialReadRetry,
  resetPartialReadRetryInflight,
  noteRecentRename,
  wasRecentlyRenamed,
  clearRecentRenames,
  ATTACHMENT_DELETE_GRACE_MS,
  reappearanceWindowRemaining,
} from '../lib/vault/externalChangeWindows';
// The user-facing toast builders live in a sibling module. The Promise-based
// drift prompts + recreate recovery live in `./vaultExternalDriftPrompts`,
// wired to the writers by that module's own deferred registration.
import {
  promptExternalAttachmentDeleted,
  promptBulkExternalChanges,
  promptReloadRecoveryIfSuspicious,
  promptPartialReadExhausted,
  promptClosedBoardFileMissing,
  promptModifiedFile,
  promptMarkdownPendingWriteConflict,
  promptPropertiesPopupModified,
  promptDeletedFile,
  type PendingPrompt,
} from './vaultExternalPrompts';

/**
 * Vault slice — external-edit pipeline. Diff prior vs next file metadata,
 * classify the change, and dispatch sync-frontmatter / reload-silently /
 * prompt-user / partial-read-retry / ignore. Cache and editor state are kept
 * in sync without a tab switch.
 *
 * The partial-read retry bookkeeping and the attachment-delete grace window
 * (module-scoped timing state + their reset helpers) live in
 * `../lib/vault/externalChangeWindows`; their reset helpers are re-exported
 * below for existing import sites (tests).
 */

export {
  resetPartialReadRetryInflight,
  _resetAttachmentDeleteGraceForTests,
} from '../lib/vault/externalChangeWindows';

// Re-export the drift prompts' public surface for existing import sites
// (`boardCache.svelte.ts` and the drift-prompt unit tests).
export {
  promptExternalEditOnSync,
  promptBoardExternalEdit,
  __inFlightDriftPromptsForTests,
} from './vaultExternalDriftPrompts';

/**
 * Threshold above which per-file dirty-editor toasts collapse
 * into a single aggregate "N files changed externally" toast with Reload all
 * / Keep all / Review actions. A bulk external edit (git checkout, rsync,
 * Obsidian sync) can affect dozens of files at once; N persistent toasts would
 * blanket the screen and make picking through them practically impossible.
 */
const PROMPT_AGGREGATION_THRESHOLD = 5;

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
      // bail on a swap; otherwise this vault's classification is applied to
      // the new vault's same-named file.
      const identity = captureVaultIdentity();
      // Single self-write authority: every entry path (bridge + partial-read
      // retry re-entry) lands here. A recent self-write is dropped only when its
      // fresh disk stat still matches our baseline — see
      // `selfWriteDivergedFromBaseline`.
      const root = ctx.getVaultPath();
      const paths: string[] = [];
      for (const rel of relPaths) {
        if (!isRecentSelfWrite(rel)) {
          paths.push(rel);
          continue;
        }
        if (root && (await selfWriteDivergedFromBaseline(root, rel))) {
          paths.push(rel);
        }
      }
      if (paths.length === 0) return;
      // A swap during the stat loop invalidates the keep/drop decisions.
      if (!isStillSameVault(identity)) return;
      // A full index rebuild clears the index then re-reads in chunks; in that
      // window getMetadata returns null, which would route a dirty-editor change
      // to a spurious prompt. Wait so `previous` reflects rebuilt metadata.
      if (vaultIndexStore.isBuilding) {
        await vaultIndexStore.whenBuildComplete();
      }
      const previousByPath = new Map<VaultPath, FileMetadata | null>();
      for (const rel of paths) {
        previousByPath.set(vaultPath(rel), vaultIndexStore.getMetadata(rel));
      }

      await vaultIndexStore.applyChanges(paths);
      // Bail if a swap landed during the awaits above, before any sink runs.
      // The per-file loop below is synchronous, so this is the only suspension
      // boundary that needs the re-check.
      if (!isStillSameVault(identity)) return;

      // Collect prompt-user changes so a bulk external edit can collapse into
      // one aggregate toast (see PROMPT_AGGREGATION_THRESHOLD).
      const pendingPrompts: PendingPrompt[] = [];

      for (const rel of paths) {
        const relKey = vaultPath(rel);
        const next = vaultIndexStore.getMetadata(rel);
        const previous = previousByPath.get(relKey) ?? null;
        const editorDoc = documentStore.findByFilename(rel);
        const editor = editorDoc
          ? { path: rel, isDirty: editorDoc.isDirty }
          : null;
        // The file is back on disk (sync re-created it,
        // a move landed, trash restore): a still-visible "missing" / "deleted
        // externally" toast for it is stale and must not stay clickable.
        if (next) {
          uiStore.dismissToastsByKey(`missing:${rel}`, { silent: true });
          uiStore.dismissToastsByKey(`ext-deleted:${rel}`, { silent: true });
        }

        const decision = classifyExternalChange({
          path: rel,
          previousMetadata: previous,
          nextMetadata: next,
          editor,
          // An open + dirty Properties popup against this
          // path converts the silent frontmatter-only sync into a
          // Reload/Keep-local toast so the popup's pending row edits
          // aren't clobbered without the user's say-so.
          propertiesPopupDirty: isPropertiesPopupDirty(rel),
        });

        // Any non-retry classification means the
        // mid-write window closed (the file's body matches the index
        // baseline, the file is now clean+equivalent, etc.). Drop the
        // retry budget so a future transient shrink starts fresh.
        if (decision.action !== 'partial-read-retry') {
          clearPartialReadRetryCount(relKey);
        }

        // Pending-local-write guard. The classifier only sees OPEN editors, so
        // a Kanban card / Task with a pending frontmatter write but no mounted
        // editor would silently reconcile and then lose to (or clobber via) the
        // pending debounce. When any scheduler has a pending/in-flight write
        // for this path (`isPathPending`, shared with the `.board.json`
        // reconciler), prompt instead. Dirty editors already route to
        // `prompt-user`.
        if (
          next &&
          (decision.action === 'sync-frontmatter' || decision.action === 'reload-silently') &&
          isPathPending(rel)
        ) {
          promptMarkdownPendingWriteConflict(rel, next, editorDoc);
          historyStore.notePossiblyStale(editorDoc?.title || rel);
          continue;
        }

        switch (decision.action) {
          case 'sync-frontmatter':
            // Pure metadata change — body unchanged, so we only need the new
            // frontmatter. Skip if `next` is missing (the file vanished
            // between classify and apply); the prompt-user branch handles
            // the deleted-file flow.
            if (!next) break;
            // Refresh the live cache so the next writer assembles from the
            // disk-canonical frontmatter, not the stale in-memory snapshot.
            // Thread the post-sync `rawFrontmatter` so the source-preserving FM
            // engine's baseline refreshes too; otherwise the next body-only
            // save would re-emit the changed key and lose its inline comment.
            if (editorDoc) documentStore.setFrontmatter(editorDoc.filename, next.frontmatter, next.rawFrontmatter);
            // The line above only refreshes an OPEN editor's FM cache; a
            // seeded-but-not-open Kanban card / Task row would keep a stale
            // cache and revert this edit on its next field write.
            dropStaleSeededFrontmatterCache(rel);
            // Re-stamp the drift baseline to the post-sync (mtime, size). This
            // branch never reloads the body, so without it the next in-app
            // save's drift check fires a false "modified externally" prompt.
            noteBaseline(rel, next.lastModified, next.rawByteSize);
            // Only true external edits invalidate undo. sync-frontmatter also
            // fires for 'first-sight' (a never-indexed file: bootstrap, fresh
            // tile creation), which is not an external edit.
            if (decision.reason === 'frontmatter-only') {
              historyStore.notePossiblyStale(editorDoc?.title || rel);
            }
            break;
          case 'reload-silently': {
            // Clean editor + external body edit — overwrite the in-memory
            // copy with disk. Requires `next` so we have the new body and
            // frontmatter to apply.
            if (!next) break;
            if (editorDoc) {
              // Snapshot the pre-reload editor state before clobbering it. The
              // editor is clean, but a partial read that slipped past the
              // heuristic could still replace it with truncated content; the
              // snapshot makes that recoverable (promptReloadRecoveryIfSuspicious).
              const priorBody = editorDoc.body;
              const priorRichText = editorDoc.richText;
              const priorFm = documentStore.getFrontmatter(editorDoc.filename);
              documentStore.handleExternalChange(
                editorDoc.filename,
                next.content,
                editorDoc.richText,
                next.frontmatter,
                // Thread the disk FM source so the reload
                // refreshes originalFrontmatterCache too (an externally-added
                // key keeps its inline comment on the next body-only save).
                next.rawFrontmatter,
                { mtimeMs: next.lastModified, size: next.rawByteSize },
              );
              promptReloadRecoveryIfSuspicious(
                rel,
                editorDoc.filename,
                priorBody,
                priorRichText,
                priorFm,
                next.content,
              );
            }
            // Same stale-cache drop as the sync-frontmatter branch, for a
            // seeded-but-not-open card/row the reload above doesn't cover.
            dropStaleSeededFrontmatterCache(rel);
            // External body replaced our in-memory snapshot, so any
            // local undo command whose inverse depends on the prior body
            // (text-tile edits, frontmatter patches) may no longer round-trip.
            // Surface the one-shot "Clear undo history" toast.
            historyStore.notePossiblyStale(editorDoc?.title || rel);
            break;
          }
          case 'prompt-user':
            if (next) {
              // Do NOT apply disk frontmatter to tile caches or the tag store
              // at prompt-open time: until the user picks Reload the editor
              // is the source of truth, and a Keep local would otherwise
              // leave disk, tag store and editor inconsistent. The Reload
              // handler in `promptModifiedFile` applies FM + tags together
              // with the body reload; Keep local force-writes the editor's
              // own FM and tags.
              if (editorDoc) {
                // Defer the prompt; we may aggregate below. Carry the
                // classifier's reason so the dispatch can pick the
                // popup-aware toast (which also cancels the popup's pending
                // writes on Reload, so they can't clobber the loaded FM).
                pendingPrompts.push({
                  kind: 'modified',
                  rel,
                  next,
                  editorDoc,
                  reason: decision.reason,
                });
              } else if (decision.reason === 'properties-popup-dirty') {
                // A dirty Properties popup over a never-loaded doc (no open
                // editor) still needs the conflict prompt, or its pending row
                // edits are silently clobbered. Dispatch the popup-aware toast
                // directly with a null editorDoc: it only needs `rel` +
                // metadata, and its FM-cache refresh is notePath-guarded.
                promptPropertiesPopupModified(rel, next, null);
              }
              // notePossiblyStale fires regardless — the undo stack's inverse
              // may no longer match disk. It's a soft signal, not a state
              // mutation, so it's safe even if the user picks Keep local.
              historyStore.notePossiblyStale(editorDoc?.title || rel);
            } else if (editorDoc) {
              // Externally deleted file with a dirty editor open: surface a
              // persistent toast, otherwise the in-memory doc silently
              // dangles (the `vault:write-existing-file-text` ENOENT
              // short-circuit stops a resurrect, but the user must choose).
              // If a sync conflict just renamed this file away and its other
              // version is about to be downloaded here, wait.
              if (deferWhileReappearing(rel, identity, () => promptDeletedFile(rel, editorDoc, ctx))) break;
              pendingPrompts.push({ kind: 'deleted', rel, editorDoc });
            }
            break;
          case 'partial-read-retry': {
            // `applyChanges` indexed a (likely truncated) snapshot. Don't
            // reload the editor; re-classify against fresh disk after a
            // delay — by then the external write has either settled with
            // real content, or the small body is genuine and classifies as
            // `ignore`.
            //
            // Restore the pre-shrink metadata so the next pass compares
            // against it, not the truncated snapshot.
            //
            // Bounded backoff (PARTIAL_READ_MAX_RETRIES attempts) so a file
            // genuinely truncated externally can't loop forever; on
            // exhaustion a toast lets the user Reload the shrunk content or
            // keep the pre-shrink baseline.
            vaultIndexStore.restoreMetadata(rel, previous);
            if (isPartialReadRetryInflight(relKey)) break;
            const attempt = getPartialReadRetryCount(relKey);
            if (attempt >= PARTIAL_READ_MAX_RETRIES) {
              clearPartialReadRetryCount(relKey);
              promptPartialReadExhausted(rel);
              break;
            }
            const handler = this.handleExternalMarkdownChanges.bind(this);
            // `schedulePartialReadRetry` marks the path in-flight, bumps the
            // attempt counter, and tracks the timer handle so vault-swap
            // reset can clearTimeout before it fires. The callback clears its
            // own entries on dispatch so the maps stay bounded.
            schedulePartialReadRetry(relKey, attempt, () => {
              // Re-enter through the shared rename queue so a concurrent
              // rename can't interleave with the retry's re-index, and a vault
              // swap between enqueue and execution skips it. Direct call only
              // in test contexts whose VaultContext stub omits the queue.
              if (ctx.enqueueRenameQueueWork) {
                void ctx.enqueueRenameQueueWork(() => handler([rel]));
              } else {
                void handler([rel]);
              }
            });
            break;
          }
          case 'ignore':
            // External delete of a file with no open editor but referenced
            // by tiles: nothing for the body-sync pipeline to do, but the
            // tiles now dangle. Surface a toast offering "Keep tiles" /
            // "Remove tiles…" (removal only behind a confirm). No auto-clean:
            // the user might be moving the file and the rename correlator
            // may still pair it.
            if (decision.reason === 'file-missing') {
              const targets = boardCacheStore.findCascadeDeleteTargets(rel);
              if (targets.tileIds.length > 0) {
                // Capture root at toast-creation time.
                const root = ctx.getVaultPath();
                const prompt = (): void => promptClosedBoardFileMissing(rel, targets.tileIds.length, root);
                if (!deferWhileReappearing(rel, identity, prompt)) prompt();
              }
            } else if (decision.reason === 'no-editor-open' && next) {
              // A closed-file body-only edit must re-stamp the drift baseline,
              // else the next in-app field edit on a card/row backed by this
              // file false-flags "modified externally".
              noteBaseline(rel, next.lastModified, next.rawByteSize);
            }
            break;
        }
      }

      // Aggregate or dispatch the prompt-user batch: one toast per file up to
      // the threshold, else a single Reload all / Keep all / Review toast.
      if (pendingPrompts.length > PROMPT_AGGREGATION_THRESHOLD) {
        promptBulkExternalChanges(pendingPrompts, ctx);
      } else {
        for (const pending of pendingPrompts) {
          if (pending.kind === 'modified') {
            // The prompt applies disk frontmatter + tags only on Reload, and
            // force-writes the editor's own on Keep local. The popup-dirty
            // variant also cancels the popup's pending writes on Reload so
            // its stale rows can't clobber the just-applied frontmatter.
            if (pending.reason === 'properties-popup-dirty') {
              promptPropertiesPopupModified(pending.rel, pending.next, pending.editorDoc);
            } else {
              promptModifiedFile(pending.rel, pending.next, pending.editorDoc);
            }
          } else {
            promptDeletedFile(pending.rel, pending.editorDoc, ctx);
          }
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

      // Drain pending writers before the cascade. A debounced write armed
      // against `oldRel` firing after the cascade rebinds tile defs would
      // target a path that no longer exists (ENOENT — silent loss).
      try {
        await withDrainedWrites(() =>
          runExternalRenameCascade(ctx, oldRel, newRel, captured),
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
                tagsAffected: true,
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
 */
async function runExternalRenameCascade(
  ctx: VaultContext,
  oldRel: string,
  newRel: string,
  captured?: VaultIdentity,
): Promise<void> {
  await boardCacheStore.ensureAllLoaded();
  // A vault swap during the drain or `ensureAllLoaded` would make the
  // synchronous cache mutations below corrupt the new vault's cache with the
  // old vault's rename paths. Bail if the vault changed.
  if (captured && !isStillSameVault(captured)) return;
  // Fire every registered path-keyed sweep before the peer rename calls so
  // the hydrate gate and drift baseline move in lock-step with the cache
  // mutation. Mirrors `vaultFolderOps.runRename`.
  renameAllPathKeys(oldRel, newRel);
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
        tagsAffected: true,
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
    // If the tag flush above failed, a tags-only rename has no board cascade
    // to carry a recovery sentinel. Lay down a minimal tags-only sentinel so
    // reopen re-asserts the tag rename (`renameCascadeRepair` handles
    // `tagsAffected` independently of `affectedBoardIds`).
    if (!tagsFlushOk && vaultRoot && oldRel && newRel) {
      try {
        await writePendingRenameCascade(vaultRoot, {
          oldPath: oldRel,
          newPath: newRel,
          affectedBoardIds: [],
          tagsAffected: true,
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
        // Record the tags.json sink so recovery re-asserts the tag
        // rename idempotently alongside the board cascade (see entry docs).
        tagsAffected: true,
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
  } else if (vaultRoot && sentinelId) {
    await clearPendingRenameCascade(vaultRoot, sentinelId).catch((err) => {
      reportError(
        'vault.handleRename.sentinel',
        err,
        "Couldn't clear completed rename-cascade sentinel",
      );
    });
  }
}

// Vault-swap reset: drops the partial-read retry timers + counter and the
// recent-rename grace map, else a same-named file in the new vault could be
// deduped by a stale entry from the prior vault. The subscriber name
// `'vaultExternalChanges'` is asserted by a characterization test.
onVaultSwap('pre-swap', 'vaultExternalChanges', () => {
  resetPartialReadRetryInflight();
  clearRecentRenames();
});

