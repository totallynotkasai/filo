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
} from '../lib/vault/externalChangeWindows';
// Audit-15 P5.1 — the user-facing prompt builders moved to sibling modules to
// keep this dispatcher under the file-size ceiling. The dispatcher calls the
// toast builders (below) directly; the Promise-based drift prompts + recreate
// recovery live in `./vaultExternalDriftPrompts` and are wired to the writers by
// that module's own deferred registration (re-exported below for byte-compat).
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

// Audit-15 P5.1 — the drift prompts moved to `./vaultExternalDriftPrompts`.
// Re-export their public surface so existing `from './vaultExternalChanges'`
// import sites (the production `boardCache.svelte.ts` markdown-edit prompt, plus
// the drift-prompt unit tests) keep resolving unchanged.
export {
  promptExternalEditOnSync,
  promptBoardExternalEdit,
  __inFlightDriftPromptsForTests,
} from './vaultExternalDriftPrompts';

/**
 * Phase 31 B2.1 — threshold above which per-file dirty-editor toasts collapse
 * into a single aggregate "N files changed externally" toast with Reload all
 * / Keep all / Review actions. A bulk external edit (git checkout, rsync,
 * Obsidian sync) can affect dozens of files at once; N persistent toasts would
 * blanket the screen and make picking through them practically impossible.
 */
const PROMPT_AGGREGATION_THRESHOLD = 5;

/**
 * M4 (Audit-13) — tiebreak for a path inside the self-write suppression window.
 * Returns true when a fresh disk stat diverges from the baseline Filo last
 * wrote (mtime OR size) — i.e. a real external editor touched the file after our
 * write, so it must NOT be dropped as our own echo. Returns false (drop it, the
 * pre-M4 behaviour) when there's no baseline anchor, the stat is unavailable, or
 * the stat matches — the data-safe direction: the worst case is the prior
 * "wait for the 30s reconcile", never resurrecting a self-write as a spurious
 * external-edit prompt.
 */
// P2.4 (Audit-15) — exported so the `.board.json` reconciler mirrors this divergence tiebreak (single authority).
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

export function makeExternalChangesSlice(ctx: VaultContext) {
  return {
    async handleExternalMarkdownChanges(relPaths: string[]): Promise<void> {
      // A8-H2(a) (Audit-8) — capture vault identity BEFORE the first await, so
      // the post-`applyChanges` guard below can bail if a swap lands during the
      // M4 stat loop / `whenBuildComplete()` / `applyChanges()` (or a retry timer
      // re-entry). Without it, this vault's classification is applied to the NEW
      // vault's same-named file. Mirrors the G1 discipline in vaultExternalReconcilers.
      const identity = captureVaultIdentity();
      // Audit-7 L15 — single self-write authority: every entry path lands here
      // (bridge + partial-read-retry re-entry), so dropping our own recent writes
      // once at the top keeps the timer path from reclassifying a self-written
      // file as external. M4 (Audit-13) — but a genuine external edit inside the
      // ~2-3s suppression window must NOT be dropped, so a recent-self-write is
      // dropped ONLY when its fresh disk stat still matches the baseline we wrote;
      // a diverged (mtime/size) stat means a second writer touched it (parity with
      // the write-side drift guard). See `selfWriteDivergedFromBaseline`.
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
      // M4 — a swap during the stat loop above invalidates the keep/drop
      // decisions (they read the outgoing vault's disk + baselines); bail before
      // any further work. The post-`applyChanges` re-check below covers the
      // remaining awaits.
      if (!isStillSameVault(identity)) return;
      // Audit-7 L14 — a full index rebuild clears the index synchronously then
      // re-reads in chunks; for that window getMetadata returns null, and a
      // null previousByPath routes a dirty-editor change to prompt-user (a
      // spurious "modified externally" toast). Wait for the rebuild so previous
      // reflects rebuilt metadata, not the mid-clear hole (the recovery
      // sequencer already gates on whenBuildComplete the same way).
      if (vaultIndexStore.isBuilding) {
        await vaultIndexStore.whenBuildComplete();
      }
      const previousByPath = new Map<VaultPath, FileMetadata | null>();
      for (const rel of paths) {
        previousByPath.set(vaultPath(rel), vaultIndexStore.getMetadata(rel));
      }

      await vaultIndexStore.applyChanges(paths);
      // A8-H2(a) — bail if a swap landed during the awaits above, before any
      // sink runs (cross-vault tags to disk, a board into the wrong cache, an
      // editor clobbered). The per-file loop below is synchronous, so this is
      // the only suspension boundary that needs the re-check.
      if (!isStillSameVault(identity)) return;

      // Phase 31 B2.1 — collect prompt-user changes so we can decide
      // whether to push per-file toasts or one aggregate toast. A bulk
      // external edit (12 files dirty + 12 prompts) blankets the screen
      // and forces the user to dismiss each one individually; aggregating
      // above the threshold gives them a single Reload all / Keep all
      // action plus a list of affected files.
      const pendingPrompts: PendingPrompt[] = [];

      for (const rel of paths) {
        const relKey = vaultPath(rel);
        const next = vaultIndexStore.getMetadata(rel);
        const previous = previousByPath.get(relKey) ?? null;
        const editorDoc = documentStore.findByFilename(rel);
        const editor = editorDoc
          ? { path: rel, isDirty: editorDoc.isDirty }
          : null;
        // Audit-19 EXT-3/EXT-4 — the file is back on disk (sync re-created it,
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
            // Phase 2 / 2.1 — the line above only refreshes an OPEN editor's FM
            // cache; a seeded-but-not-open Kanban card / Task row backed by `rel`
            // would otherwise keep a stale cache and revert this external edit on
            // its next field write. Drop it so the next seed re-reads fresh disk.
            dropStaleSeededFrontmatterCache(rel);
            // A8-M2 — re-stamp the per-file drift baseline to the post-sync
            // (mtime, size). The sibling reload-silently branch threads the same
            // {mtimeMs, size} into handleExternalChange (→ noteBaseline) for
            // exactly this reason; sync-frontmatter never reloads the body, so it
            // must re-anchor the baseline itself. Without it the stale baseline
            // makes the NEXT in-app save's pre-write drift check fire a false
            // "modified externally" prompt the user can mis-answer with Reload
            // (losing a keystroke). Per-file (keyed the way the gateway's
            // getBaseline reads it), so it applies whether or not an editor is open.
            noteBaseline(rel, next.lastModified, next.rawByteSize);
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
                // L1 (Audit-13) — thread the disk FM source so the reload
                // refreshes originalFrontmatterCache too (an externally-added
                // key keeps its inline comment on the next body-only save).
                next.rawFrontmatter,
                { mtimeMs: next.lastModified, size: next.rawByteSize },
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
            // Phase 2 / 2.1 — same stale-cache drop as the sync-frontmatter
            // branch: a seeded-but-not-open card/row backed by `rel` isn't
            // covered by the `if (editorDoc)` reload above, so clear it and let
            // the next field edit re-seed from fresh disk.
            dropStaleSeededFrontmatterCache(rel);
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
              } else if (decision.reason === 'properties-popup-dirty') {
                // Audit-17 5.8 — a dirty Properties popup over a NEVER-loaded
                // doc (no open editor) still needs the conflict prompt. The
                // classifier already routed this to prompt-user (the popup's
                // pending row edits would otherwise be silently clobbered by
                // the external frontmatter sync), but the editorDoc-gated push
                // above dropped it. Dispatch the popup-aware toast directly
                // (sync, inside the loop — like the F4 pending-write conflict
                // above) with a null editorDoc: the prompt only needs `rel` +
                // metadata, and its FM-cache refresh is docId-guarded (5.8).
                promptPropertiesPopupModified(rel, next, null);
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
              // L15 (Audit-13) — re-enter through the shared rename queue, not a
              // bare `void handler([rel])`. The timer fires off the event loop
              // with no ordering or identity guard; a concurrent rename rebinding
              // this path could interleave with the retry's re-index. The queue
              // serialises by arrival order AND skips the task if the vault
              // swapped between enqueue and execution (the same guard every other
              // watcher-driven task already inherits). Falls back to a direct call
              // only in test contexts whose VaultContext stub omits the queue.
              if (ctx.enqueueRenameQueueWork) {
                void ctx.enqueueRenameQueueWork(() => handler([rel]));
              } else {
                void handler([rel]);
              }
            });
            break;
          }
          case 'ignore':
            // Phase 31 B2.5 — external delete of a file with no open editor
            // but referenced by tiles. The classifier returns `ignore` here
            // because there's nothing the body-sync pipeline can do, but
            // silent isn't right either — the tiles on every board now
            // dangle. Surface a warning toast that names the file and
            // offers "Keep tiles" / "Remove tiles…" (Audit-19 EXT-4: removal only behind a confirm). We don't auto-clean
            // because the user might be moving the file (the rename
            // correlator may still pair it on the next event in the
            // batch); waiting for an explicit choice is safer.
            if (decision.reason === 'file-missing') {
              const targets = boardCacheStore.findCascadeDeleteTargets(rel);
              if (targets.tileIds.length > 0) {
                // Phase 1 / 1.3 — capture root at toast-creation time.
                promptClosedBoardFileMissing(rel, targets.tileIds.length, ctx.getVaultPath());
              }
            } else if (decision.reason === 'no-editor-open' && next) {
              // L5 (Audit-13) — a closed-file body-only edit the index already
              // absorbed (no editor, FM unchanged) must re-stamp the per-file
              // drift baseline; else the stale (pre-edit) baseline makes the NEXT
              // in-app field edit on a card/row backed by this file false-flag
              // "modified externally". The sync-frontmatter / reload-silently
              // siblings already re-anchor; this closes the no-editor body hole.
              noteBaseline(rel, next.lastModified, next.rawByteSize);
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

      // G1 — capture the vault identity BEFORE the drain. `withDrainedWrites`
      // awaits the writer pipelines, which yields the event loop; a vault swap
      // can interleave there and the cascade would then run against the NEW
      // vault's cache with the OLD rename's paths. Capturing pre-drain lets the
      // cascade's internal checks bail if the vault changed under the await.
      const captured = captureVaultIdentity();
      // Audit-17 3.6 — capture the root pre-drain too, for the drain-failure
      // breadcrumb below (post-drain the vault may have swapped).
      const preDrainVaultRoot = ctx.getVaultPath();

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
          runExternalRenameCascade(ctx, oldRel, newRel, captured),
        );
      } catch (err) {
        if (err instanceof PendingWritesFailedError) {
          // Drain toasted; we still skip the cascade so we don't propagate
          // partial state. Audit-17 3.6 — but the OS rename already happened,
          // and the "next reconcile pass picks it up" assumption is false:
          // the watcher advances its reconcile snapshot BEFORE synthesised
          // events debounce, so a walk-surfaced rename is never
          // re-synthesised. Without a breadcrumb the skipped cascade is
          // silent — boards at least surface broken-ref badges, but the old
          // path's vault-local attachment tags are pruned permanently by
          // `pruneOrphanFileTags` on next open. Lay the rename-cascade
          // sentinel (matching the success path's "sentinel BEFORE the
          // flush" discipline) so next-open recovery replays the cascade:
          // `repairRenameCascade` recomputes the affected boards itself, so
          // an empty `affectedBoardIds` is sufficient. Guarded — a swap
          // during the drain means the breadcrumb would land in the wrong
          // vault (and the write IPC would be refused anyway).
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
      // L16 (Audit-13) — capture the generation-aware identity BEFORE the grace
      // window below, so a close→reopen of the SAME path (a new generation that a
      // bare `getVaultPath() !== vaultRoot` string compare silently passes) is
      // detected and the deferred prompt is dropped.
      const identity = captureVaultIdentity();
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
        // Vault swap during the grace window? Drop the prompt. L16 (Audit-13) —
        // generation-aware (catches close→reopen of the same path), replacing the
        // prior `ctx.getVaultPath() !== vaultRoot` string compare.
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
  captured?: VaultIdentity,
): Promise<void> {
  await boardCacheStore.ensureAllLoaded();
  // G1 — a vault swap may have landed during the `withDrainedWrites` drain or
  // this `ensureAllLoaded` await. The synchronous cache mutations below
  // (renameAllPathKeys / renameBoardPath / propagateRename) target the ACTIVE
  // boardCache; running them against the new vault's cache with the old
  // vault's rename paths corrupts it. Bail if the vault changed.
  if (captured && !isStillSameVault(captured)) return;
  // Phase 6.1.R4 — fire every registered path-keyed sweep BEFORE the
  // peer rename calls below so the hydrate gate and drift baseline
  // transfer in lock-step with the cache mutation. Mirrors the
  // in-app rename cascade in `vaultFolderOps.runRename`.
  renameAllPathKeys(oldRel, newRel);
  const renamedBoardIds = boardCacheStore.renameBoardPath(oldRel, newRel);
  const changedBoardIds = boardStore.propagateRename(oldRel, newRel);
  fileTagsStore.renameFile(oldRel, newRel);
  fileTagsStore.renameFolder(oldRel, newRel);
  // Audit-7 L17 — capture the OUTGOING vault root and lay the rename-cascade
  // breadcrumb HERE, before the tag-flush await + the post-flush
  // isStillSameVault bail below. propagateRename already mutated the in-memory
  // board cache; if a vault swap lands during that flush, the bail discards the
  // cache while the on-disk `.board.json` still holds the OLD path — so without
  // an early breadcrumb the outgoing vault's cascade is abandoned with no retry.
  // Only when propagateRename actually touched a board: the defaultFolder
  // rewrite + index/doc/activeRoot edits all run AFTER the bail, so a swap can't
  // have applied them (nothing to recover there). The no-swap path reuses this
  // id below and never double-writes.
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
        // A9-L9 — include renamed boards (own .board.json moved), not just
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
  // F3 (2026-05-28) — persist the tag-membership rename synchronously rather
  // than leaving it on the 300ms misc debounce. A crash after the awaited
  // board flush below but before that debounce fired would leave
  // `.filo/tags.json` keyed by the OLD path while every `.board.json` already
  // pointed at the new one. Flushing here (before the `hasCascadeWork`
  // early-return, so a tags-only rename is covered too) closes the window;
  // a failed flush surfaces through the misc-write error pipeline.
  //
  // 6.4.M19 — but a *rejection* here must not abort the rest of the cascade
  // (board flush + recovery sentinel), or the propagated board edits are left
  // un-flushed AND unprotected. The realistic write-failure path already
  // resolves `{ ok: false }` via the scheduler's internal catch (so it doesn't
  // reach here); this guards the narrow synchronous getArgs-throw path and any
  // future regression. The sentinel's `tagsAffected` flag makes recovery
  // re-assert the tag rename on next vault open regardless.
  // Audit-4 DI-17 — capture the flush outcome. `flushPendingSave` resolves
  // `{ ok: false }` on the realistic write-failure path (the misc scheduler
  // catches the IPC error internally) and only throws on the narrow
  // synchronous-getArgs path, so both must mark the flush failed.
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
  // G1 — re-check after the `flushPendingSave` await above: a swap there means
  // the index/doc/activeRoot/defaultFolder mutations below would corrupt the
  // NEW vault with the OLD rename paths. The cascade breadcrumb is already
  // written above against the captured outgoing `vaultRoot` (Audit-7 L17).
  if (captured && !isStillSameVault(captured)) return;
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

  // Audit-7 L17 — `vaultRoot` was captured before the tag-flush bail above.
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
    // Audit-4 DI-17 — F3 above flushed the tag-membership rename synchronously,
    // so on a SUCCESSFUL flush there's nothing to recover and we keep the
    // C-A5-4 skip (a sentinel here would be pure noise). But if that flush
    // FAILED, a tags-only rename has no board cascade to carry a recovery
    // sentinel, so the failed tag rename would be silently unrecoverable —
    // contradicting the F3 catch's "the recovery sentinel will re-assert it"
    // promise. Lay down a minimal tags-only sentinel (no affected boards) so
    // reopen re-asserts the tag rename idempotently (`renameCascadeRepair`
    // handles `tagsAffected` independently of `affectedBoardIds`).
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

  // Audit-7 L17 — write the board-cascade sentinel here ONLY if the early
  // breadcrumb (before the tag-flush bail) wasn't already laid down. The early
  // write covers the propagateRename cache mutation (changed/renamed boards);
  // this late write covers the case where ONLY the defaultFolder pin changed
  // (computed after the bail, so it can't appear in the early breadcrumb).
  if (sentinelId === null && vaultRoot && oldRel && newRel) {
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

