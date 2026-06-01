import { vaultPath, type VaultPath } from '../../shared/vaultPath';
import type { FileMetadata } from '../lib/vault/vaultIndex';
import { vaultIndexStore } from './vaultIndex.svelte';
import { documentStore } from './document.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { uiStore } from './ui.svelte';
import { classifyExternalChange } from '../lib/vault/conflictResolver';
import { normalizeTags } from '../lib/vault/frontmatterSync';
import { assembleMarkdownFile } from '../lib/editor/markdownSync';
import { reportError } from '../lib/utils/errorBus';
import { trackComponentWrite, isPathPending } from '../lib/boards/boardSaver';
import { cancelFrontmatterWrite } from '../lib/boards/frontmatterWriteScheduler';
import { invokeOk } from '../lib/utils/invokeOk';
import {
  flushAllMarkdownWrites,
  forceWriteForDocument,
  markHydrated,
  cancelMarkdownWrite,
  setExternalEditPromptHandler,
} from '../lib/vault/markdownFileWriter';
import { setBoardExternalEditHandler } from '../lib/boards/boardWriteScheduler';
import {
  isPropertiesPopupDirty,
  getDirtyInstancesForPath,
  clearPropertiesPopupDirty,
} from '../lib/vault/propertiesPopupTracker';
import { historyStore } from './history.svelte';
import {
  writePendingRenameCascade,
  clearPendingRenameCascade,
  markRenameCascadeFlushFailed,
} from '../lib/vault/renameCascadeSentinel';
import {
  PendingWritesFailedError,
  withDrainedWrites,
} from '../lib/vault/vaultOperations';
import { syncOpenEditorsAfterDiskMutation } from '../lib/vault/syncOpenEditorsAfterDiskMutation';
import { registerPathRenamable, renameAllPathKeys } from '../lib/vault/renamePathKeys';
import type { DocumentState } from './document.svelte';
import type { VaultContext } from './vaultStoreTypes';
import { onVaultSwap, vaultSwapResettable } from '../core/vaultLifecycle';
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
} from '../lib/vault/externalChangeWindows';

/**
 * Vault slice — external-edit pipeline. Diff prior vs next file metadata,
 * classify the change, and dispatch sync-frontmatter / reload-silently /
 * prompt-user / partial-read-retry / ignore. Cache and editor state are kept
 * in sync without a tab switch.
 *
 * The partial-read retry bookkeeping and the attachment-delete grace window
 * (module-scoped timing state + their reset helpers) live in
 * `../lib/vault/externalChangeWindows` (extracted in Phase 2 / audit plan 7.9
 * to keep this orchestrator under its file-size ceiling). `resetPartialRead-
 * RetryInflight` and `_resetAttachmentDeleteGraceForTests` are re-exported
 * below so existing import sites (tests) keep working unchanged.
 */

// Phase 2 / 7.9 — re-export the moved symbols so external import paths
// (`@renderer/stores/vaultExternalChanges`) stay byte-compatible.
export {
  resetPartialReadRetryInflight,
  _resetAttachmentDeleteGraceForTests,
} from '../lib/vault/externalChangeWindows';

/**
 * Phase 31 B2.1 — threshold above which per-file dirty-editor toasts collapse
 * into a single aggregate "N files changed externally" toast with Reload all
 * / Keep all / Review actions. A bulk external edit (git checkout, rsync,
 * Obsidian sync) can affect dozens of files at once; N persistent toasts would
 * blanket the screen and make picking through them practically impossible.
 */
const PROMPT_AGGREGATION_THRESHOLD = 5;

export function makeExternalChangesSlice(ctx: VaultContext) {
  return {
    async handleExternalMarkdownChanges(relPaths: string[]): Promise<void> {
      const previousByPath = new Map<VaultPath, FileMetadata | null>();
      for (const rel of relPaths) {
        previousByPath.set(vaultPath(rel), vaultIndexStore.getMetadata(rel));
      }

      await vaultIndexStore.applyChanges(relPaths);

      // Phase 31 B2.1 — collect prompt-user changes so we can decide
      // whether to push per-file toasts or one aggregate toast. A bulk
      // external edit (12 files dirty + 12 prompts) blankets the screen
      // and forces the user to dismiss each one individually; aggregating
      // above the threshold gives them a single Reload all / Keep all
      // action plus a list of affected files.
      const pendingPrompts: PendingPrompt[] = [];

      for (const rel of relPaths) {
        const relKey = vaultPath(rel);
        const next = vaultIndexStore.getMetadata(rel);
        const previous = previousByPath.get(relKey) ?? null;
        const editorDoc = documentStore.findByFilename(rel);
        const editor = editorDoc
          ? { path: rel, isDirty: editorDoc.isDirty }
          : null;

        const decision = classifyExternalChange({
          path: rel,
          previousMetadata: previous,
          nextMetadata: next,
          editor,
          // Sprint C / C.1 — an open + dirty Properties popup against this
          // path converts the silent frontmatter-only sync into a
          // Reload/Keep-local toast so the popup's pending row edits
          // aren't clobbered without the user's say-so.
          propertiesPopupDirty: isPropertiesPopupDirty(rel),
        });

        // Phase 3 / 3.2 — any non-retry classification means the
        // mid-write window closed (the file's body matches the index
        // baseline, the file is now clean+equivalent, etc.). Drop the
        // retry budget so a future transient shrink starts fresh.
        if (decision.action !== 'partial-read-retry') {
          clearPartialReadRetryCount(relKey);
        }

        // F4 — pending-local-write guard. The classifier only sees OPEN
        // editors, so a Kanban card / Task with a pending scheduled
        // frontmatter write but no mounted editor classifies as a silent
        // sync-frontmatter / reload-silently — then the pending local debounce
        // fires last-write-wins. `isPathPending` (Phase 4 E3) is the single
        // authority both this `.md` classifier and the `.board.json`
        // reconciler consult: when any scheduler has a pending/in-flight write
        // for this path, prompt instead of silently reconciling. Dirty editors
        // already route to `prompt-user`, so this only covers the no-dirty-
        // editor case.
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
            boardStore.applyFrontmatterToBackedTiles(rel, next);
            fileTagsStore.setFileTags(rel, normalizeTags(next.frontmatter.tags));
            // Refresh the live cache so the next writer assembles from the
            // disk-canonical frontmatter, not the stale in-memory snapshot.
            // 6.2.H1 — thread the post-sync `rawFrontmatter` so the source-
            // preserving FM engine's baseline refreshes too; otherwise the
            // next body-only save's diff would re-emit the externally-
            // changed key and lose any inline YAML comment on that key.
            if (editorDoc) documentStore.setFrontmatter(editorDoc.docId, next.frontmatter, next.rawFrontmatter);
            // Phase A.2b — only true external edits invalidate undo. The
            // classifier returns sync-frontmatter for two reasons:
            //   - 'frontmatter-only' — a real external metadata edit; its
            //     inverse may leave undo stacks stale.
            //   - 'first-sight'       — we'd never indexed this file before
            //     (bootstrap, fresh tile creation). Bootstrap is not an
            //     external edit — surfacing the "Earlier undo steps may
            //     no longer match disk" toast for every newly created tile
            //     made the app unusable.
            if (decision.reason === 'frontmatter-only') {
              historyStore.notePossiblyStale(editorDoc?.title || rel);
            }
            break;
          case 'reload-silently': {
            // Clean editor + external body edit — overwrite the in-memory
            // copy with disk. Requires `next` so we have the new body and
            // frontmatter to apply.
            if (!next) break;
            boardStore.applyFrontmatterToBackedTiles(rel, next);
            fileTagsStore.setFileTags(rel, normalizeTags(next.frontmatter.tags));
            if (editorDoc) {
              // M5 (2026-05-28) — snapshot the pre-reload editor state BEFORE
              // clobbering it. reload-silently only fires for a CLEAN editor,
              // so there are no unsaved edits to lose — but a mis-judged
              // transient / partial read that slipped past the partial-read
              // heuristic can still replace the user's view with truncated
              // content. The captured snapshot makes that recoverable (see
              // promptReloadRecoveryIfSuspicious).
              const priorBody = editorDoc.body;
              const priorRichText = editorDoc.richText;
              const priorFm = documentStore.getFrontmatter(editorDoc.docId);
              documentStore.handleExternalChange(
                editorDoc.docId,
                next.content,
                editorDoc.richText,
                next.frontmatter,
              );
              promptReloadRecoveryIfSuspicious(
                rel,
                editorDoc.docId,
                priorBody,
                priorRichText,
                priorFm,
                next.content,
              );
            }
            // M25 — external body replaced our in-memory snapshot, so any
            // local undo command whose inverse depends on the prior body
            // (text-tile edits, frontmatter patches) may no longer round-trip.
            // Surface the one-shot "Clear undo history" toast.
            historyStore.notePossiblyStale(editorDoc?.title || rel);
            break;
          }
          case 'prompt-user':
            if (next) {
              // Phase 3 / 3.3 — DO NOT apply disk frontmatter to tile
              // caches or the tag store at prompt-open time. Until the
              // user explicitly picks Reload, the editor is the source
              // of truth; eagerly merging the external frontmatter +
              // tags would silently clobber the editor's in-progress
              // changes the moment the watcher event fired.
              //
              // The pre-Phase-3 behaviour was: applyFrontmatterToBackedTiles
              // + setFileTags ran unconditionally here, so when the user
              // later picked Keep local, the editor force-wrote its
              // frontmatter back to disk but the tag store + tile-def
              // caches still showed the external tags — a three-way
              // inconsistency between disk, tag store, and editor.
              //
              // The Reload action handler in `promptModifiedFile`
              // applies the deferred frontmatter + tag updates atomically
              // with the editor body reload, so a confirmed reload still
              // lands in a consistent state. The Keep-local handler
              // force-writes the editor's existing frontmatter and tags
              // back to disk; no external state leaks in.
              if (editorDoc) {
                // Defer the prompt; we may aggregate below.
                // Sprint C / C.1 — carry the classifier's reason so the
                // per-file dispatch can pick the popup-aware toast that
                // also cancels the popup's pending gateway writes on
                // Reload (otherwise a debounce fired after Reload would
                // clobber the just-loaded external frontmatter).
                pendingPrompts.push({
                  kind: 'modified',
                  rel,
                  next,
                  editorDoc,
                  reason: decision.reason,
                });
              }
              // notePossiblyStale fires regardless — the external write
              // happened on disk and the undo stack's inverse may no
              // longer match it. This is a soft "you may want to clear
              // undo" signal, not a state mutation; it's safe to surface
              // even if the user later picks Keep local (their undos
              // are still valid against the editor's body, but a future
              // external read of disk wouldn't round-trip).
              historyStore.notePossiblyStale(editorDoc?.title || rel);
            } else if (editorDoc) {
              // Externally deleted file with a dirty editor open. The
              // classifier returns prompt-user (reason: editor-dirty), and
              // we must surface a persistent toast — otherwise the in-memory
              // doc silently dangles and the 300ms debounce hitting after
              // the delete would resurrect the file (mitigated by Phase 1's
              // `vault:write-existing-file-text` ENOENT short-circuit, but
              // the user still needs to choose).
              pendingPrompts.push({ kind: 'deleted', rel, editorDoc });
            }
            break;
          case 'partial-read-retry': {
            // Phase 22 M9 — `applyChanges` above has already updated the
            // index with the (likely truncated) snapshot. Don't reload the
            // editor; schedule a delayed re-classify against fresh disk
            // state. By the time the timer fires, either (a) the external
            // write has settled with real content, in which case the next
            // pass classifies normally and applies it, or (b) the disk
            // genuinely contains the small body and the next pass falls
            // through `isBodyEquivalent` to `ignore` (because the index
            // baseline now matches). Track in-flight retries so a
            // perpetually-mid-write file can't trigger an unbounded loop.
            //
            // Phase 31 A4.4 — also restore the prior metadata baseline.
            // Without this, the next retry pass would compare its fresh
            // (hopefully-grown-back) snapshot against the truncated
            // baseline applyChanges just wrote, missing the shrink
            // detection. Restoring `previous` puts the index back to
            // the pre-shrink state so the next pass classifies
            // correctly.
            //
            // Phase 3 / 3.2 — bounded backoff. The previous unbounded
            // 500 ms loop would burn CPU forever against a file the user
            // genuinely truncated externally. We now cap at 3 attempts
            // with a 500 / 1500 / 3000 ms schedule (cumulative 5 s) and
            // surface a confirm toast on exhaustion. The user picks: take
            // the new (likely-genuine) shrunk content via Reload, or
            // leave the editor pointing at the pre-shrink baseline.
            vaultIndexStore.restoreMetadata(rel, previous);
            if (isPartialReadRetryInflight(relKey)) break;
            const attempt = getPartialReadRetryCount(relKey);
            if (attempt >= PARTIAL_READ_MAX_RETRIES) {
              clearPartialReadRetryCount(relKey);
              promptPartialReadExhausted(rel);
              break;
            }
            const handler = this.handleExternalMarkdownChanges.bind(this);
            // Phase A.5 — `schedulePartialReadRetry` marks the path
            // in-flight, bumps the attempt counter, and tracks the timer
            // handle so vault-swap reset can clearTimeout before it fires.
            // The callback clears its own entries on dispatch so the maps
            // stay bounded.
            schedulePartialReadRetry(relKey, attempt, () => {
              void handler([rel]);
            });
            break;
          }
          case 'ignore':
            // Phase 31 B2.5 — external delete of a file with no open editor
            // but referenced by tiles. The classifier returns `ignore` here
            // because there's nothing the body-sync pipeline can do, but
            // silent isn't right either — the tiles on every board now
            // dangle. Surface a warning toast that names the file and
            // offers "Mark broken refs" / "Dismiss". We don't auto-clean
            // because the user might be moving the file (the rename
            // correlator may still pair it on the next event in the
            // batch); waiting for an explicit choice is safer.
            if (decision.reason === 'file-missing') {
              const targets = boardCacheStore.findCascadeDeleteTargets(rel);
              if (targets.tileIds.length > 0) {
                // Phase 1 / 1.3 — capture root at toast-creation time.
                promptClosedBoardFileMissing(rel, targets.tileIds.length, ctx.getVaultPath());
              }
            }
            break;
        }
      }

      // Phase 31 B2.1 — aggregate or dispatch the prompt-user batch. Under
      // the threshold (default ≤5) we push one toast per file so the user
      // can decide individually; over the threshold we collapse into a
      // single Reload all / Keep all / Review toast.
      if (pendingPrompts.length > PROMPT_AGGREGATION_THRESHOLD) {
        promptBulkExternalChanges(pendingPrompts, ctx);
      } else {
        for (const pending of pendingPrompts) {
          if (pending.kind === 'modified') {
            // Phase 3 / 3.3 — direct call to a Phase-3-aware prompt that
            // applies disk frontmatter + tags ONLY on Reload, and
            // force-writes the editor's existing frontmatter + tags
            // back to disk on Keep local. The pre-Phase-3 path through
            // `documentStore.handleExternalChange` could not coordinate
            // these cross-store updates and so the side-effects had to
            // be eagerly applied above (the bug we're fixing).
            //
            // Sprint C / C.1 — popup-dirty path uses a sibling toast that
            // also cancels the popup's pending gateway writes on Reload
            // (otherwise a debounce armed for the popup's stale rows
            // would fire after Reload and clobber the just-applied
            // external frontmatter).
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
     * Phase 2 / 2.2 — external rename handler. Funnelled here from the
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
      // D.4 — record that this oldPath was just renamed so a parallel
      // `handleExternalAttachmentChanges` for the same path (the watcher
      // can emit deleted-old + created-new events before the correlator
      // pairs them into a single rename event) can suppress its prompt.
      noteRecentRename(oldRel);

      // Phase R2 — drain pending writers BEFORE the cascade. The OS
      // already did the rename, but a debounced editor write armed
      // against `oldRel` is sitting in-memory; if it fires *after* the
      // cascade rebinds tile defs to `newRel`, the writer would write
      // to a path that no longer exists (ENOENT — silent loss).
      // Draining first lets that writer either land at its OLD path
      // (which the watcher then re-classifies as "created externally")
      // or — more commonly — flush against the now-rebound path via
      // the rename-aware writer registrations.
      try {
        await withDrainedWrites(() =>
          runExternalRenameCascade(ctx, oldRel, newRel),
        );
      } catch (err) {
        if (err instanceof PendingWritesFailedError) {
          // Drain toasted; we still skip the cascade so we don't propagate
          // partial state. The next reconcile pass will pick the rename
          // up if anything pinned to `oldRel` is still referenced.
          return;
        }
        throw err;
      }
    },

    /**
     * Phase 2 / 2.1 — external attachment delete handler. The watcher's
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
      // D.4 — defer the prompt by the grace window so a cross-folder
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
        // Vault swap during the grace window? Drop the prompt — the
        // captured `vaultRoot` no longer matches the active vault.
        if (ctx.getVaultPath() !== vaultRoot) return;
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
        // Phase 1 / 1.3 — outer-scoped `vaultRoot` anchors the cascade;
        // the swap check earlier already returned if a swap happened.
        promptExternalAttachmentDeleted(rel, stillTargets.tileIds.length, vaultRoot);
      });
      await Promise.all(tasks);
    },
  };
}

/**
 * Phase R2 — runs the external-rename cascade inside `withDrainedWrites`.
 * Extracted from the `handleExternalRename` method so the body lives in
 * a single sequence the wrapper can re-run after a successful drain.
 *
 * The cascade mirrors the in-app rename's post-IPC follow-up (renameBoardPath,
 * propagateRename, tags, doc filename, activeRootFolder, defaultFolder pins,
 * sentinel breadcrumb, flushAllDirty + failed-paths toast).
 */
async function runExternalRenameCascade(
  ctx: VaultContext,
  oldRel: string,
  newRel: string,
): Promise<void> {
  await boardCacheStore.ensureAllLoaded();
  // Phase 6.1.R4 — fire every registered path-keyed sweep BEFORE the
  // peer rename calls below so the hydrate gate and drift baseline
  // transfer in lock-step with the cache mutation. Mirrors the
  // in-app rename cascade in `vaultFolderOps.runRename`.
  renameAllPathKeys(oldRel, newRel);
  const renamedBoardIds = boardCacheStore.renameBoardPath(oldRel, newRel);
  const changedBoardIds = boardStore.propagateRename(oldRel, newRel);
  fileTagsStore.renameFile(oldRel, newRel);
  fileTagsStore.renameFolder(oldRel, newRel);
  // F3 (2026-05-28) — persist the tag-membership rename synchronously rather
  // than leaving it on the 300ms misc debounce. A crash after the awaited
  // board flush below but before that debounce fired would leave
  // `.filo/tags.json` keyed by the OLD path while every `.board.json` already
  // pointed at the new one. Flushing here (before the `hasCascadeWork`
  // early-return, so a tags-only rename is covered too) closes the window;
  // a failed flush surfaces through the misc-write error pipeline.
  await fileTagsStore.flushPendingSave();
  // Sprint B / B9 — rebind vault search to the new path immediately.
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
  const openDoc = documentStore.findByFilename(oldRel);
  if (openDoc) documentStore.updateFilename(openDoc.docId, newRel);

  const vaultRoot = ctx.getVaultPath();
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

  // Sprint C / C-A5-4 — skip the sentinel write entirely when the
  // cascade touched nothing. Three independent signals contribute:
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
  // When all three are empty there's no in-flight cascade state to
  // recover from on next vault open. Writing a fresh sentinel in
  // that case is pure noise: the only way to reach this branch is
  // an in-app rename's watcher echo that survived suppression
  // (closely related to C-A5-1; this is defence in depth).
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
    // Nothing to flush and no sentinel to clear. Bail before the
    // sentinel write + flushAllDirty pair.
    return;
  }

  let sentinelId: string | null = null;
  if (vaultRoot && oldRel && newRel) {
    try {
      sentinelId = await writePendingRenameCascade(vaultRoot, {
        oldPath: oldRel,
        newPath: newRel,
        affectedBoardIds: [...changedBoardIds],
        // E5 — record the tags.json sink so recovery re-asserts the tag
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

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Drops the partial-read retry timers + counter and the recent-rename
// grace map. A same-named file in the new vault would otherwise be
// deduped from re-classification by a stale entry from the prior vault.
// The reset bodies live in `lib/vault/externalChangeWindows`; this store
// keeps the `'vaultExternalChanges'` swap subscription (the
// characterization test asserts that subscriber name exists).
onVaultSwap('pre-swap', 'vaultExternalChanges', () => {
  resetPartialReadRetryInflight();
  clearRecentRenames();
});

/**
 * Phase 2 / 2.1 — toast for an external delete of an attachment file
 * (image/video/audio/pdf/etc.) referenced by at least one tile, cover image,
 * or frame background. Same shape as `promptClosedBoardFileMissing` but
 * names the attachment basename so the user can scan the toast at a glance.
 *
 * On confirm: routes through the existing undoable cascade so Ctrl+Z still
 * restores placements. `fileSnapshots` is empty because the file is
 * already gone — undo restores tiles but not bodies (which is symmetric
 * with how the in-app sidebar delete handles oversized media).
 */
function promptExternalAttachmentDeleted(
  rel: string,
  tileCount: number,
  // Phase 1 / 1.3 — `vaultRoot` threads through to anchor the cascade
  // command's vault-swap guard rather than relying on the empty-string
  // default constructor.
  vaultRoot: string,
): void {
  const filename = rel.split('/').pop() || rel;
  uiStore.pushToast({
    text: `"${filename}" was deleted externally — ${tileCount} reference${tileCount === 1 ? '' : 's'} (tiles, cover images, frame backgrounds) on existing boards now point at a missing file.`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Remove references',
        handler: () => {
          boardStore.cascadeDeleteByVaultPath(rel, {}, vaultRoot);
        },
      },
      {
        label: 'Dismiss',
        handler: () => {
          // No-op — leaves the broken refs in place so the user can attempt
          // a restore (e.g. recover from trash) without losing tile layout.
        },
      },
    ],
  });
}

type PendingPrompt =
  | {
      kind: 'modified';
      rel: string;
      next: FileMetadata;
      editorDoc: DocumentState;
      // Sprint C / C.1 — distinguishes the editor-dirty path from the
      // popup-dirty path so dispatch can pick the right toast (and the
      // popup-aware Reload handler can cancel the popup's pending gateway
      // writes).
      reason: 'editor-dirty' | 'properties-popup-dirty';
    }
  | { kind: 'deleted'; rel: string; editorDoc: DocumentState };

/**
 * Phase 31 B2.1 — single aggregate toast for a bulk external-change batch
 * with > PROMPT_AGGREGATION_THRESHOLD dirty editors affected. Actions:
 *  - Reload all: apply every modified file from disk, drop every
 *    deleted file's in-memory doc. Local edits are lost (the user
 *    chose).
 *  - Keep all: re-create deleted files from in-memory bodies, mark
 *    modified docs dirty so the next flush pushes local back to disk.
 *  - Review: dismiss and surface a second toast listing the affected
 *    file paths so the user can still decide per file (by acting on
 *    each editor manually).
 */
function promptBulkExternalChanges(prompts: PendingPrompt[], ctx: VaultContext): void {
  // Phase B / B.5 — snapshot frontmatter + body for every deleted-kind
  // entry NOW, while the docs are still loaded. Same race as the per-file
  // promptDeletedFile path: if a tab close / vault swap unloads the doc
  // between toast-open and Keep-all-click, the live `getFrontmatter`
  // lookup returns undefined and `recreateDeletedFile` lands body-only.
  const deletedSnapshots = new Map<
    string,
    { fmSnapshot: Record<string, unknown>; bodySnapshot: string }
  >();
  for (const p of prompts) {
    if (p.kind !== 'deleted') continue;
    deletedSnapshots.set(p.editorDoc.docId, {
      fmSnapshot: { ...(documentStore.getFrontmatter(p.editorDoc.docId) ?? {}) },
      bodySnapshot: p.editorDoc.body,
    });
  }
  const count = prompts.length;
  const modifiedCount = prompts.filter((p) => p.kind === 'modified').length;
  const deletedCount = count - modifiedCount;
  const summary =
    deletedCount === 0
      ? `${count} files changed externally with unsaved edits.`
      : modifiedCount === 0
        ? `${count} files were deleted externally with unsaved edits.`
        : `${count} files changed externally with unsaved edits (${deletedCount} deleted).`;
  uiStore.pushToast({
    text: `${summary} Reload all (lose local), Keep all (overwrite disk), or Review individually?`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Reload all',
        handler: () => {
          for (const p of prompts) {
            if (p.kind === 'modified') {
              // Phase 3 / 3.3 — apply the deferred frontmatter + tag
              // updates atomically with the body reload so reload-all
              // lands in a consistent state. The single-file Reload
              // handler in `promptModifiedFile` mirrors this trio.
              boardStore.applyFrontmatterToBackedTiles(p.rel, p.next);
              fileTagsStore.setFileTags(p.rel, normalizeTags(p.next.frontmatter.tags));
              documentStore.applyReloadFromDisk(
                p.editorDoc.docId,
                p.next.content,
                p.editorDoc.richText,
                p.next.frontmatter,
              );
              // Sprint C / C.1 — for popup-dirty entries also cancel any
              // pending gateway writes from the dirty popup(s) so a late
              // debounce doesn't overwrite the just-applied external
              // frontmatter. Mirrors the single-file
              // `promptPropertiesPopupModified` Reload handler.
              if (p.reason === 'properties-popup-dirty') {
                for (const callerId of getDirtyInstancesForPath(p.rel)) {
                  cancelMarkdownWrite(callerId);
                  clearPropertiesPopupDirty(callerId);
                }
              }
            } else {
              documentStore.unloadDocument(p.editorDoc.docId);
              // Phase 4.2 (2026-05-30) — Reload-all accepted the deletion of
              // this file; drop its tags.json membership (mirrors the single-
              // file Reload). Keep-all re-creates the files, so it must not.
              fileTagsStore.dropFile(p.rel);
            }
          }
        },
      },
      {
        label: 'Keep all',
        handler: () => {
          for (const p of prompts) {
            if (p.kind === 'modified') {
              // Mark dirty so the next writer flush pushes local content
              // back to disk over the external edit.
              documentStore.markDirty(p.editorDoc.docId);
            } else {
              // Phase B / B.5 — pass the snapshot captured at toast-open
              // so a parallel unload between then and now doesn't drop
              // the doc's frontmatter on the floor.
              void recreateDeletedFile(p.rel, p.editorDoc, ctx, deletedSnapshots.get(p.editorDoc.docId));
            }
          }
          // Drain every armed markdown writer so the user's Keep-all
          // choice lands on disk immediately — without this, the next
          // external edit could race the still-pending debounce and
          // re-trigger the same prompt. Matches the per-doc Keep-local
          // handler in documentStore.handleExternalChange.
          void flushAllMarkdownWrites();
        },
      },
      {
        label: 'Review',
        handler: () => {
          // Surface the affected paths so the user can act on the open
          // editors individually. Cap the list at 10 to avoid an
          // unreadable wall of text; remainder is summarised.
          const previewCount = 10;
          const previewPaths = prompts.slice(0, previewCount).map((p) => p.rel);
          const overflow = prompts.length - previewPaths.length;
          const lines = previewPaths.map((p) => `• ${p}`);
          if (overflow > 0) lines.push(`+${overflow} more`);
          uiStore.pushToast({
            text: `Files awaiting review:\n${lines.join('\n')}`,
            type: 'info',
            duration: 0,
          });
        },
      },
    ],
  });
}

/**
 * Phase 3 / 3.2 — toast surfaced after `PARTIAL_READ_MAX_RETRIES` retries
 * fail to find the disk content stable. Two outcomes:
 *
 *   - Reload: force-refresh the index against current disk state and apply
 *     it to the editor regardless of the partial-read heuristic. Used when
 *     the user can confirm the file genuinely shrunk (saving a few words,
 *     deleting half the body). Bypasses the classifier — we cannot
 *     distinguish a genuine shrink from a stuck-mid-write at this point,
 *     so we trust the user's intent.
 *   - Keep my view: do nothing. The editor stays on the pre-shrink
 *     baseline restored by `restoreMetadata`. The next external edit
 *     re-classifies normally (the retry counter was cleared on
 *     exhaustion).
 */
/**
 * M5 — recovery affordance for a silent reload that turned out to be a
 * suspicious (material) shrink: the signature of a mis-judged transient /
 * partial read that slipped past the partial-read heuristic. Routine edits
 * and growth reload silently; only a >50% drop on a non-trivial file surfaces
 * the toast. "Undo reload" restores the captured pre-reload body + richText +
 * frontmatter and force-writes it back to disk (Keep-local semantics) so the
 * recovery survives the external truncation on disk too. Length is compared
 * in UTF-16 code units (`.length`) — a coarse proxy that's plenty for a 50%
 * gate.
 */
const RELOAD_RECOVERY_MIN_PRIOR_CHARS = 256;
const RELOAD_RECOVERY_SHRINK_RATIO = 0.5;

function promptReloadRecoveryIfSuspicious(
  rel: string,
  docId: string,
  priorBody: string,
  priorRichText: DocumentState['richText'],
  priorFm: Record<string, unknown> | undefined,
  newBody: string,
): void {
  if (priorBody.length < RELOAD_RECOVERY_MIN_PRIOR_CHARS) return;
  // Only a material shrink (lost more than half the content) is suspicious.
  if (newBody.length >= priorBody.length * RELOAD_RECOVERY_SHRINK_RATIO) return;

  const filename = rel.split('/').pop() || rel;
  uiStore.pushToast({
    text: `"${filename}" shrank sharply in an external edit and was reloaded. Undo the reload to restore your previous content?`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Undo reload',
        handler: () => {
          // Restore the pre-reload editor state, mark dirty, and force-write
          // so the recovered content lands back on disk over the external
          // truncation. `forceWriteForDocument` bypasses the per-writer
          // debounce guard, matching the dirty-editor "Keep local" path.
          documentStore.applyReloadFromDisk(docId, priorBody, priorRichText, priorFm);
          documentStore.markDirty(docId);
          void forceWriteForDocument(docId);
        },
      },
      {
        label: 'Keep reloaded',
        handler: () => {
          // No-op — the user accepts the reloaded (shrunk) content.
        },
      },
    ],
  });
}

function promptPartialReadExhausted(rel: string): void {
  const filename = rel.split('/').pop() || rel;
  uiStore.pushToast({
    text: `"${filename}" appears to have shrunk externally — Filo couldn't get a stable read after several retries. Reload from disk now, or keep your current view?`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Reload from disk',
        handler: async () => {
          const editorDoc = documentStore.findByFilename(rel);
          // No editor open — nothing to reload into. The classifier would
          // route a future change through `ignore`/`sync-frontmatter`
          // anyway. The index refresh below still happens so a freshly-
          // opened tile sees the current disk state.
          await vaultIndexStore.applyChanges([rel]);
          const next = vaultIndexStore.getMetadata(rel);
          if (!next) return;
          boardStore.applyFrontmatterToBackedTiles(rel, next);
          fileTagsStore.setFileTags(rel, normalizeTags(next.frontmatter.tags));
          if (editorDoc) {
            // Phase 3 / 3.2 — bypass the dirty-editor prompt entirely:
            // the user just clicked Reload, so we apply unconditionally.
            // `applyReloadFromDisk` clears `isDirty` so any pending
            // markdown writer drops its outstanding scheduled write
            // (the writer self-disarms when the doc transitions to
            // clean).
            documentStore.applyReloadFromDisk(
              editorDoc.docId,
              next.content,
              editorDoc.richText,
              next.frontmatter,
            );
          }
        },
      },
      {
        label: 'Keep my view',
        handler: () => {
          // No-op. The index was restored to `previous` on the retry
          // path, so the editor + tile caches still reflect the
          // pre-shrink baseline. A future external edit re-enters the
          // classifier with a fresh retry budget.
        },
      },
    ],
  });
}

/**
 * Phase 31 B2.5 — toast for an external delete of a file referenced by
 * tile(s) on at least one board, with NO open editor for it. The "Mark
 * broken refs" action runs the existing cascade-delete walk so every
 * referencing tile gets removed (with undo, via the existing command);
 * "Dismiss" leaves the broken refs in place so the user can attempt a
 * restore (e.g. recover from trash) without losing their tile layout.
 */
function promptClosedBoardFileMissing(
  rel: string,
  tileCount: number,
  // Phase 1 / 1.3 — see `promptExternalAttachmentDeleted` for rationale.
  vaultRoot: string,
): void {
  const filename = rel.split('/').pop() || rel;
  uiStore.pushToast({
    text: `"${filename}" was deleted externally — ${tileCount} tile${tileCount === 1 ? '' : 's'} on closed boards now reference a missing file.`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Mark broken refs',
        handler: () => {
          // Routes through the existing undoable cascade so the user can
          // Ctrl+Z if they made a mistake. fileSnapshots empty because the
          // file is already gone — undo restores tiles but not bodies.
          boardStore.cascadeDeleteByVaultPath(rel, {}, vaultRoot);
          // Phase 4.2 (2026-05-30) — the user confirmed the file is gone
          // (no open editor case); drop its tags.json membership so the
          // orphan entry doesn't linger until the next vault open. "Dismiss"
          // leaves it intact in case the user restores the file from trash.
          fileTagsStore.dropFile(rel);
        },
      },
      {
        label: 'Dismiss',
        handler: () => {
          // No-op — toast auto-dismisses via the action click.
        },
      },
    ],
  });
}

/**
 * Phase 3 / 3.3 — toast for a dirty editor whose backing `.md` file was
 * edited externally. Replaces the prior path through
 * `documentStore.handleExternalChange` so the disk frontmatter + tags are
 * applied ONLY when the user picks Reload — not eagerly at prompt-open
 * time. The pre-Phase-3 behaviour silently clobbered the editor's tag set
 * with the disk version the instant the watcher event fired, even if the
 * user later picked Keep local.
 *
 * Reload: apply external frontmatter to tile-def caches, push external
 *   tags into the tag store, overwrite the editor body with disk. The
 *   trio runs atomically so a confirmed reload lands consistent across
 *   all three sinks.
 *
 * Keep local: re-fire the editor's writer via `forceWriteForDocument` so
 *   the user's in-memory body + frontmatter lands on disk. Tile caches +
 *   tag store stay on the editor's view (they were never updated to the
 *   external version).
 */
function promptModifiedFile(
  rel: string,
  next: FileMetadata,
  editorDoc: DocumentState,
): void {
  uiStore.pushToast({
    text: `"${editorDoc.title || rel}" was modified externally. Reload from disk, or keep your local edits?`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Reload',
        handler: () => {
          // Atomic trio — match the bulk Reload-all branch.
          boardStore.applyFrontmatterToBackedTiles(rel, next);
          fileTagsStore.setFileTags(rel, normalizeTags(next.frontmatter.tags));
          documentStore.applyReloadFromDisk(
            editorDoc.docId,
            next.content,
            editorDoc.richText,
            next.frontmatter,
          );
        },
      },
      {
        label: 'Keep local',
        handler: () => {
          // Mark dirty first so a concurrent reactive-reload $effect
          // can't undo the editor body before the write lands. Then
          // force the registered writer (TextTile or DocumentEditor) to
          // flush IMMEDIATELY — bypassing the debounce-timer guard that
          // would otherwise let the external edit on disk persist if
          // the prior 300 ms debounce already fired. Mirrors the
          // documentStore.handleExternalChange Keep-local path that
          // this helper replaces.
          documentStore.markDirty(editorDoc.docId);
          void forceWriteForDocument(editorDoc.docId);
        },
      },
    ],
  });
}

/**
 * F4 (2026-05-28) — Reload / Keep-local prompt for a path with a pending
 * LOCAL write the editor-based classifier couldn't see. Mirrors
 * `promptBoardChangedExternally` (the board-JSON equivalent).
 *
 * Reload cancels the pending frontmatter write (so it can't re-clobber) and
 * applies the disk frontmatter + tags (plus body when an editor is open).
 * Keep local is a no-op — the pending write fires and overwrites the external
 * edit; an info toast confirms the choice.
 */
function promptMarkdownPendingWriteConflict(
  rel: string,
  next: FileMetadata,
  editorDoc: DocumentState | null,
): void {
  const label = editorDoc?.title || rel;
  uiStore.pushToast({
    text: `"${label}" was modified externally while you have an unsaved change to it. Reload from disk (discard your change), or keep your change (overwrite on next save)?`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Reload',
        handler: () => {
          // Cancel the still-armed local frontmatter write first; without
          // this it would fire ~300 ms later and overwrite the disk version
          // we're about to apply, defeating the user's Reload choice.
          cancelFrontmatterWrite(rel);
          boardStore.applyFrontmatterToBackedTiles(rel, next);
          fileTagsStore.setFileTags(rel, normalizeTags(next.frontmatter.tags));
          if (editorDoc) {
            documentStore.applyReloadFromDisk(
              editorDoc.docId,
              next.content,
              editorDoc.richText,
              next.frontmatter,
            );
          }
        },
      },
      {
        label: 'Keep local',
        handler: () => {
          uiStore.pushToast({
            text: `Your unsaved change to "${label}" will overwrite the external edit on the next save.`,
            type: 'info',
            duration: 4000,
          });
        },
      },
    ],
  });
}

/**
 * Sprint C / C.1 — toast for an external frontmatter-only edit to a file
 * whose Properties popup is open with unflushed row edits. The body is
 * unchanged (the classifier only routes here from the body-equivalent
 * short-circuit), so we never need to touch the editor body — only the
 * frontmatter caches, tag store, and the popup's pending writes.
 *
 * Reload: apply external frontmatter to tile-def caches + tag store +
 *   editor's frontmatter cache, then cancel every pending gateway write
 *   from popup instances dirty against this path. Without the cancel, a
 *   debounce armed for the popup's pre-Reload rows would fire moments
 *   later and overwrite the just-applied external frontmatter — defeating
 *   the user's choice. The popup itself remains open; its `rows` state
 *   stays on the user's view until they close + re-open the popup, which
 *   matches the "Reload, but my popup display is stale" trade-off the
 *   user implicitly accepted.
 *
 * Keep local: the popup's debounced gateway write will fire naturally
 *   (300 ms after the most recent row edit) and land the user's
 *   frontmatter on disk over the external edit. No special action needed
 *   here beyond an explicit user-visible confirmation.
 */
function promptPropertiesPopupModified(
  rel: string,
  next: FileMetadata,
  editorDoc: DocumentState,
): void {
  const filename = editorDoc.title || rel;
  uiStore.pushToast({
    text: `Properties of "${filename}" were modified externally while your Properties popup has unsaved edits. Reload from disk (discard popup edits) or keep your local edits?`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Reload',
        handler: () => {
          // Apply external frontmatter trio. The body is unchanged
          // (sync-frontmatter precondition), so applyReloadFromDisk is
          // overkill — setFrontmatter is enough to refresh the editor's
          // FM cache for any later body-only writer.
          boardStore.applyFrontmatterToBackedTiles(rel, next);
          fileTagsStore.setFileTags(rel, normalizeTags(next.frontmatter.tags));
          documentStore.setFrontmatter(editorDoc.docId, next.frontmatter);
          // Cancel any popup gateway timer armed for this path so the
          // user's discarded rows don't land on disk after the debounce
          // fires. Clearing the tracker entry is also defensive — a
          // still-open popup that hadn't yet typed further would
          // otherwise re-block the next sync-frontmatter for this path.
          for (const callerId of getDirtyInstancesForPath(rel)) {
            cancelMarkdownWrite(callerId);
            clearPropertiesPopupDirty(callerId);
          }
        },
      },
      {
        label: 'Keep local',
        handler: () => {
          // No state mutation — the popup's debounced gateway write
          // will fire shortly with the user's rows-as-frontmatter,
          // overwriting the external edit. We surface a follow-up
          // info toast so the user sees their choice landed (mirrors
          // the promptExternalEditOnSync Keep-local path).
          uiStore.pushToast({
            text: `External property edit to "${filename}" will be overwritten with your popup changes.`,
            type: 'info',
            duration: 4000,
          });
        },
      },
    ],
  });
}

/**
 * Surfaces a persistent toast when a backing `.md` file disappears externally
 * while a dirty editor is open. The user must explicitly choose Reload (drop
 * the in-memory doc) or Keep local (re-create the file on disk with the
 * dirty contents) — auto-dismissal would silently default to one outcome,
 * losing either upstream intent or local work.
 */
function promptDeletedFile(
  rel: string,
  editorDoc: { docId: string; title: string; body: string },
  ctx: VaultContext,
): void {
  // Phase B / B.5 — snapshot the frontmatter at toast-open time. If a
  // parallel flow (vault swap, tab close) calls
  // `documentStore.unloadDocument(editorDoc.docId)` between toast-open
  // and Keep-local-click, `documentStore.getFrontmatter` returns
  // undefined and the recreated file lands body-only — losing tags /
  // properties / any other frontmatter keys. Capturing into a closure
  // means even if the live cache vanishes, the user's choice can still
  // honour the data they were looking at when they hit Keep local.
  //
  // Body is also captured for the same reason (the doc unload would
  // wipe `editorDoc.body` since DocumentState is the live store).
  const fmSnapshot = { ...(documentStore.getFrontmatter(editorDoc.docId) ?? {}) };
  const bodySnapshot = editorDoc.body;
  uiStore.pushToast({
    text: `"${editorDoc.title || rel}" was deleted externally. Reload (drop in-memory copy), or keep your local edits and re-create the file?`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Reload',
        handler: () => {
          // Drop the in-memory doc — the file is gone, the user wants the
          // delete to win. Pending writers in TextTile / DocumentEditor are
          // self-disarming on ENOENT via `vault:write-existing-file-text`
          // (Phase 1), so we don't need to reach into their debounce
          // timers from here.
          documentStore.unloadDocument(editorDoc.docId);
          // Phase 4.2 (2026-05-30) — the user accepted the deletion, so drop
          // the file's `.filo/tags.json` membership too. Without this the
          // orphan entry lingers until the next vault-open pruneOrphanFileTags.
          // (Suppressed on Keep local — that path re-creates the file.)
          fileTagsStore.dropFile(rel);
        },
      },
      {
        label: 'Keep local',
        handler: async () => {
          await recreateDeletedFile(rel, editorDoc, ctx, {
            fmSnapshot,
            bodySnapshot,
          });
        },
      },
    ],
  });
}

/**
 * Audit2 5.2 — in-flight prompt registry. While a Reload / Keep-local toast
 * is open for `path`, every concurrent caller awaits the SAME Promise so a
 * second / third keystroke that also armed a body write doesn't pile a
 * duplicate toast onto the stack. Cleared when the promise settles (either
 * branch), so a *subsequent* external edit + write race opens a fresh
 * prompt. Test-only access via `__inFlightDriftPromptsForTests` below.
 *
 * Phase 6.1.R2 — reset on vault swap so a stale unresolved entry can't
 * block a fresh prompt for the same path in the new vault.
 */
const inFlightDriftPrompts = new Map<string, Promise<'reload' | 'keep-local'>>();
vaultSwapResettable('vaultExternalChanges.inFlightDriftPrompts', () => inFlightDriftPrompts.clear());
// Phase 6.1.R4 — transfer any in-flight prompt promise from oldRel to
// newRel so a Reload/Keep-local toast still in flight when the user
// renames the file doesn't get stranded under the old key (where no
// caller looks anymore) AND so a post-rename keystroke for the new
// path doesn't open a duplicate prompt.
registerPathRenamable('vaultExternalChanges.inFlightDriftPrompts', (oldRel, newRel) => {
  const inflight = inFlightDriftPrompts.get(oldRel);
  if (inflight === undefined) return;
  inFlightDriftPrompts.delete(oldRel);
  inFlightDriftPrompts.set(newRel, inflight);
});

/**
 * Phase A.3 — surfaces a Reload / Keep-local prompt when `syncTileMarkdown`
 * detects an external edit landed in the read/write gap (file mtime
 * changed between the pre-read stat and the pre-write stat).
 *
 * Returns a Promise that resolves to the user's choice:
 *   - 'reload' — vault index is refreshed against disk, fresh content
 *                is applied to the tile cache and (if open) the editor.
 *                The caller skips its write.
 *   - 'keep-local' — caller proceeds with the write. A confirmation
 *                    toast is surfaced so the user sees their choice
 *                    landed.
 *
 * Modelled on `promptModifiedFile` above but Promise-based because the
 * sync caller needs to branch on the outcome before deciding whether to
 * write. Persistent toast (duration: 0) — user MUST choose; the sync
 * stays in-flight until they do.
 *
 * Audit2 5.2 — per-path dedupe: every concurrent caller for the same
 * `path` awaits the same Promise so a typing storm against an externally-
 * edited file produces ONE toast and ONE decision, not N.
 */
export function promptExternalEditOnSync(args: {
  path: string;
}): Promise<'reload' | 'keep-local'> {
  const { path } = args;
  const existing = inFlightDriftPrompts.get(path);
  if (existing) return existing;

  const promise = new Promise<'reload' | 'keep-local'>((resolve) => {
    const editorDoc = documentStore.findByFilename(path);
    uiStore.pushToast({
      text: `"${editorDoc?.title || path}" was modified externally between Filo's read and write. Reload from disk, or keep your local edits?`,
      type: 'warning',
      duration: 0,
      // The toast now auto-dismisses (15s cap) and can be closed manually.
      // Either path must resolve the awaiting write — default to keep-local
      // (proceed with the write) so a timed-out / dismissed prompt preserves
      // the user's in-memory edits rather than hanging the write forever.
      onDismiss: () => resolve('keep-local'),
      actions: [
        {
          label: 'Reload',
          handler: () => {
            // Refresh the vault index against the latest disk state, then
            // pull the resulting FileMetadata. If the file vanished, fall
            // back to keep-local (the upstream write will ENOENT-skip).
            void (async () => {
              await vaultIndexStore.applyChanges([path]);
              const next = vaultIndexStore.getMetadata(path);
              if (!next) {
                resolve('keep-local');
                return;
              }
              boardStore.applyFrontmatterToBackedTiles(path, next);
              fileTagsStore.setFileTags(path, normalizeTags(next.frontmatter.tags));
              if (editorDoc) {
                documentStore.applyReloadFromDisk(
                  editorDoc.docId,
                  next.content,
                  editorDoc.richText,
                  next.frontmatter,
                );
              }
              resolve('reload');
            })();
          },
        },
        {
          label: 'Keep local',
          handler: () => {
            uiStore.pushToast({
              text: `External edit to "${editorDoc?.title || path}" overwritten with local changes.`,
              type: 'info',
              duration: 4000,
            });
            resolve('keep-local');
          },
        },
      ],
    });
  });

  inFlightDriftPrompts.set(path, promise);
  // Drop the entry when the prompt settles (success OR rejection) so a
  // future external-edit race opens a fresh prompt. `.finally` runs after
  // the await chain in callers, so the next caller in the same microtask
  // window still observes the in-flight promise.
  void promise.finally(() => {
    // Guard against an unrelated re-register having replaced our entry in
    // the gap — only clear if the slot still points at our promise.
    if (inFlightDriftPrompts.get(path) === promise) {
      inFlightDriftPrompts.delete(path);
    }
  });
  return promise;
}

/**
 * Test-only — exposes the in-flight prompt map size + entries for assertion.
 * Production code should never need this.
 */
export function __inFlightDriftPromptsForTests(): {
  size: number;
  has: (path: string) => boolean;
} {
  return {
    size: inFlightDriftPrompts.size,
    has: (path: string) => inFlightDriftPrompts.has(path),
  };
}

async function recreateDeletedFile(
  rel: string,
  editorDoc: { docId: string; body: string },
  ctx: VaultContext,
  snapshot?: {
    fmSnapshot: Record<string, unknown>;
    bodySnapshot: string;
  },
): Promise<void> {
  const vaultRoot = ctx.getVaultPath();
  if (!vaultRoot) return;

  // Phase B / B.5 — prefer LIVE state when the doc still exists in the
  // store (so user edits between toast-open and Keep-local click are
  // honoured), fall back to the snapshot when the doc was unloaded mid-
  // flow. The doc-loaded check via `getDocument` is the canonical
  // "is this docId still alive" probe: a parallel unload would have
  // removed it from `openDocuments`.
  const stillLoaded = documentStore.getDocument(editorDoc.docId) !== undefined;
  const liveFm = stillLoaded ? documentStore.getFrontmatter(editorDoc.docId) : undefined;
  let fm: Record<string, unknown> | null = null;
  let body: string | null = null;
  if (stillLoaded && liveFm) {
    fm = liveFm;
    body = editorDoc.body;
  } else if (snapshot) {
    fm = snapshot.fmSnapshot;
    body = snapshot.bodySnapshot;
  }
  if (fm === null || body === null) {
    // Defence in depth — neither live nor snapshot available. Without
    // a confirm-and-fallback, the user's "Keep local" click would
    // either silently no-op or write an empty file. Surface a confirm
    // that names the trade-off and lets them decide.
    const proceedBodyOnly = await new Promise<boolean>((resolve) => {
      uiStore.openConfirm({
        title: 'Recover without frontmatter?',
        body:
          `Frontmatter for "${rel}" couldn't be recovered (the editor closed before you clicked Keep local). ` +
          'Re-create the file with body content only? Tags, properties, and other YAML keys will be lost.',
        confirmLabel: 'Recreate body-only',
        danger: true,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!proceedBodyOnly) return;
    fm = {};
    body = editorDoc.body ?? '';
  }

  const fileText = assembleMarkdownFile(fm, body);
  try {
    // Use the file-creating channel here (not the gateway's `writeMarkdownFile`,
    // which uses `vault:write-existing-file-text`) — the user explicitly opted
    // to re-create the file the watcher reported missing, so mkdir -p
    // semantics are the desired behaviour.
    await trackComponentWrite(vaultRoot, rel, async () => {
      // allow-direct-write: explicit user-opt-in file recreation after an
      // external delete. `markHydrated(rel, false)` below re-registers
      // the file with the gateway for the next debounced editor write.
      await invokeOk('vault:write-file-text', vaultRoot, rel, fileText);
    });
    // Orphan-fm semantics: file just created on disk via the file-creating
    // channel. Mark hydrated so subsequent gateway writes (e.g. the user
    // making further edits in a still-open editor) can proceed without
    // throwing. BOM is set to false — the assembled fileText didn't include
    // one and the recreated file matches the assembly.
    markHydrated(rel, false);
    // Phase 6.1.R1 — route through the shared helper instead of the bare
    // `documentStore.markClean(...)` this replaced. The point is the cancel,
    // not the reload: a debounced body write armed BEFORE the Keep-local
    // click closure-captures the pre-recovery body and would otherwise fire
    // ~300 ms later, silently reverting the recreation. `applyReloadFromDisk`
    // self-cancels (6.0.C2); markClean only flipped the dirty flag.
    syncOpenEditorsAfterDiskMutation([{ path: rel, content: fileText }]);
  } catch (err) {
    reportError(
      'vaultExternalChanges',
      err,
      `Failed to re-create "${rel}" on disk. Local edits remain in memory but are not yet on disk.`,
    );
  }
}

/**
 * Phase R6 — Reload / Keep-local prompt for board JSON drift. Mirrors
 * `promptExternalEditOnSync` (which targets `.md` editors) but the body
 * names the .board.json path instead. Resolves to:
 *   - 'reload' — user wants Filo to discard the in-memory cache and let
 *                disk win. The caller is responsible for any reload
 *                bookkeeping; the toast just resolves and returns.
 *   - 'keep-local' — user wants their in-memory edits to overwrite the
 *                    external change. The caller proceeds with the write.
 *
 * Persistent toast (duration: 0) — user MUST choose; the write stays
 * paused until they do.
 */
export function promptBoardExternalEdit(args: {
  path: string;
}): Promise<'reload' | 'keep-local'> {
  const { path } = args;
  return new Promise((resolve) => {
    uiStore.pushToast({
      text: `"${path}" was modified externally between Filo's load and the next save. Reload from disk (discard in-memory changes), or keep your local edits?`,
      type: 'warning',
      duration: 0,
      // Auto-dismiss / manual close resolves to keep-local so the paused
      // write proceeds with the user's in-memory edits instead of hanging.
      onDismiss: () => resolve('keep-local'),
      actions: [
        {
          label: 'Reload',
          handler: () => {
            // Caller decides how to surface the reload. We just signal
            // the choice; the writer treats it as "abort this write".
            resolve('reload');
          },
        },
        {
          label: 'Keep local',
          handler: () => {
            uiStore.pushToast({
              text: `External edit to "${path}" will be overwritten on the next save.`,
              type: 'info',
              duration: 4000,
            });
            resolve('keep-local');
          },
        },
      ],
    });
  });
}

// Phase R6 — register the Reload / Keep-local prompts with the writers
// at module load. The writers (in `lib/`) can't import from `stores/`
// directly without circular dependencies, so the wiring goes the other
// direction via setters. The registration is wrapped in `queueMicrotask`
// because the import graph contains pre-existing partial-evaluation
// cycles (markdownFileWriter ↔ documentStore, and vaultIndexStore →
// vaultStore → vaultExternalChanges): dispatching
// on the microtask queue ensures every module in the cycle has finished
// its synchronous top-level evaluation — and therefore published every
// exported symbol — before we look up the setter.
//
// `typeof === 'function'` guards defend against test environments
// where the importing module's binding may not be live when the
// microtask fires (vitest's per-test module reset can swap bindings
// mid-microtask). In production both will always be functions.
queueMicrotask(() => {
  if (typeof setExternalEditPromptHandler === 'function') {
    setExternalEditPromptHandler((path) => promptExternalEditOnSync({ path }));
  }
  if (typeof setBoardExternalEditHandler === 'function') {
    setBoardExternalEditHandler((path) => promptBoardExternalEdit({ path }));
  }
});
