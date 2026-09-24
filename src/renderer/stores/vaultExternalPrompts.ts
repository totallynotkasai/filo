/**
 * Vault slice — external-edit USER PROMPTS.
 *
 * The dispatcher in `vaultExternalChanges.ts` classifies a watcher event and,
 * for cases needing a human decision, calls one of the Reload / Keep-local /
 * delete / recreate toast builders defined here.
 *
 * Dependency direction: the dispatcher imports these builders; nothing here
 * imports back into the dispatcher, the rename cascade, or the slice — every
 * builder takes the already-captured `VaultContext` / identity as an argument.
 *
 * The `prompt*` builders that re-read disk via `vaultIndexStore.applyChanges()`
 * and then mutate stores are scanned by `scripts/gates:reconciler-vault-guard`.
 */
import type { FileMetadata } from '../lib/vault/vaultIndex';
import { vaultIndexStore } from './vaultIndex.svelte';
import { documentStore } from './document.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { reportError } from '../lib/utils/errorBus';
import { uiStore } from './ui.svelte';
import { cancelFrontmatterWrite, dropPendingDelta } from '../lib/boards/frontmatterWriteScheduler';
import { forceWriteForDocument, cancelMarkdownWrite } from '../lib/vault/markdownFileWriter';
import {
  getDirtyInstancesForPath,
  clearPropertiesPopupDirty,
} from '../lib/vault/propertiesPopupTracker';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
// The no-editor / setFrontmatter Reload paths re-anchor the drift baseline and
// drop the seeded-but-not-open FM cache (applyReloadFromDisk does both itself).
import { noteBaseline } from '../lib/vault/fileBaselineRegistry';
import { dropStaleSeededFrontmatterCache } from '../lib/vault/staleSeededFrontmatter';
import type { DocumentState } from './document.svelte';
import type { VaultContext } from './vaultStoreTypes';
import { recreateDeletedFile } from './vaultExternalDriftPrompts';
import { backupExternalVersion } from '../lib/vault/keepLocalBackup';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';

/**
 * Toast for an external delete of an attachment file
 * (image/video/audio/pdf/etc.) referenced by at least one tile, cover image,
 * or frame background. Same shape as `promptClosedBoardFileMissing` but
 * names the attachment basename so the user can scan the toast at a glance.
 *
 * On confirm: routes through the existing undoable cascade so Ctrl+Z still
 * restores placements. `fileSnapshots` is empty because the file is
 * already gone — undo restores tiles but not bodies.
 */
export function promptExternalAttachmentDeleted(
  rel: string,
  tileCount: number,
  // Anchors the cascade command's vault-swap guard.
  vaultRoot: string,
): void {
  const filename = rel.split('/').pop() || rel;
  uiStore.pushToast({
    text: `"${filename}" was deleted externally — ${tileCount} reference${tileCount === 1 ? '' : 's'} (tiles, cover images, frame backgrounds) on existing boards now point at a missing file.`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `missing:${rel}`,
    actions: [
      {
        label: 'Remove references',
        // Behind a danger confirm listing the boards, with a click-time
        // re-probe: a synthesised rename or trash restore can bring the file
        // back. Attachments keep their tags (fileTags drop is the .md path's
        // concern).
        handler: () => confirmRemoveTilesForMissingFile(rel, vaultRoot, false),
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

export type PendingPrompt =
  | {
      kind: 'modified';
      rel: string;
      next: FileMetadata;
      editorDoc: DocumentState;
      // Distinguishes the editor-dirty path from the
      // popup-dirty path so dispatch can pick the right toast (and the
      // popup-aware Reload handler can cancel the popup's pending gateway
      // writes).
      reason: 'editor-dirty' | 'properties-popup-dirty';
    }
  | { kind: 'deleted'; rel: string; editorDoc: DocumentState };

/**
 * Single aggregate toast for a bulk external-change batch
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
export function promptBulkExternalChanges(prompts: PendingPrompt[], ctx: VaultContext): void {
  // Snapshot frontmatter + body for every deleted-kind entry NOW, while the
  // docs are loaded: if a tab close / vault swap unloads a doc before the
  // Keep-all click, `recreateDeletedFile` would otherwise land body-only.
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
    sticky: true,
    dedupeKey: 'ext-bulk',
    actions: [
      {
        label: 'Reload all',
        // Async so the toast harness / tests wait for the per-file disk
        // re-reads to land before continuing (mirrors promptModifiedFile).
        handler: async () => {
          // Capture identity before the per-file disk re-reads; a vault swap
          // during any `applyChanges` await would otherwise apply the outgoing
          // vault's disk content to the new vault's same-named stores.
          const identity = captureVaultIdentity();
          for (const p of prompts) {
            if (p.kind === 'modified') {
              // Re-read the LATEST disk state at click time rather than the
              // detection-time `p.next` snapshot — a second external write since
              // detection would otherwise be reverted. Falls back to `p.next` if
              // the file vanished in the gap.
              await vaultIndexStore.applyChanges([p.rel]);
              if (!isStillSameVault(identity)) return;
              const fresh = vaultIndexStore.getMetadata(p.rel) ?? p.next;
              // Apply frontmatter + tags atomically with the body reload so
              // reload-all lands in a consistent state.
              // Discard any armed field delta BEFORE the reload,
              // else applyReloadFromDisk's flushAllPendingFrontmatterWrites would
              // re-apply the discarded edit to fresh disk and revert this reload.
              dropPendingDelta(p.rel);
              documentStore.applyReloadFromDisk(
                p.editorDoc.docId,
                fresh.content,
                p.editorDoc.richText,
                fresh.frontmatter,
                fresh.rawFrontmatter, // refresh originalFrontmatterCache too
                { mtimeMs: fresh.lastModified, size: fresh.rawByteSize },
              );
              // For popup-dirty entries also cancel the dirty popup(s)' pending
              // gateway writes so a late debounce doesn't overwrite the
              // just-applied external frontmatter.
              if (p.reason === 'properties-popup-dirty') {
                for (const callerId of getDirtyInstancesForPath(p.rel)) {
                  cancelMarkdownWrite(callerId);
                  clearPropertiesPopupDirty(callerId);
                }
              }
            } else {
              documentStore.unloadDocument(p.editorDoc.docId);
              // Reload-all accepted the deletion; drop its tags.json
              // membership. Keep-all re-creates the files, so it must not.
              fileTagsStore.dropFile(p.rel);
            }
          }
        },
      },
      {
        label: 'Keep all',
        handler: async () => {
          const identity = captureVaultIdentity();
          const vaultRoot = ctx.getVaultPath();
          for (const p of prompts) {
            if (p.kind === 'modified') {
              // Back up each external version first; a file whose backup the
              // user declined to skip is left untouched.
              if (!vaultRoot || !(await backupExternalVersion(vaultRoot, p.rel))) continue;
              if (!isStillSameVault(identity)) return;
              // markDirty first (so a concurrent reactive reload can't undo the
              // body), then force the write: a doc whose debounce already fired
              // has no armed timer, so a plain flush would write nothing.
              documentStore.markDirty(p.editorDoc.docId);
              void forceWriteForDocument(p.editorDoc.docId);
            } else {
              // Pass the toast-open snapshot so a parallel unload since then
              // doesn't drop the doc's frontmatter.
              void recreateDeletedFile(p.rel, p.editorDoc, ctx, deletedSnapshots.get(p.editorDoc.docId), (fresh) => {
                const live = documentStore.getDocument(p.editorDoc.docId);
                if (live) promptModifiedFile(p.rel, fresh, live); // the file is back
              });
            }
          }
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
 * Recovery affordance for a silent reload that turned out to be a
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

export function promptReloadRecoveryIfSuspicious(
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

/**
 * Toast surfaced after `PARTIAL_READ_MAX_RETRIES` retries fail to find the
 * disk content stable. Two outcomes:
 *
 *   - Reload: force-refresh the index against current disk state and apply
 *     it to the editor regardless of the partial-read heuristic. We can't
 *     tell a genuine shrink from a stuck mid-write here, so we trust the user.
 *   - Keep my view: do nothing. The editor stays on the pre-shrink
 *     baseline restored by `restoreMetadata`. The next external edit
 *     re-classifies normally (the retry counter was cleared on
 *     exhaustion).
 */
export function promptPartialReadExhausted(rel: string): void {
  const filename = rel.split('/').pop() || rel;
  uiStore.pushToast({
    text: `"${filename}" appears to have shrunk externally — Filo couldn't get a stable read after several retries. Reload from disk now, or keep your current view?`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Reload from disk',
        handler: async () => {
          // Capture identity before the disk re-read so a vault swap during it
          // can't apply the outgoing vault's content to the new vault's stores.
          const identity = captureVaultIdentity();
          const editorDoc = documentStore.findByFilename(rel);
          // No editor open — nothing to reload into. The classifier would
          // route a future change through `ignore`/`sync-frontmatter`
          // anyway. The index refresh below still happens so a freshly-
          // opened tile sees the current disk state.
          await vaultIndexStore.applyChanges([rel]);
          if (!isStillSameVault(identity)) return;
          const next = vaultIndexStore.getMetadata(rel);
          if (!next) return;
          if (editorDoc) {
            // The user just clicked Reload, so apply unconditionally (no
            // dirty-editor prompt). `applyReloadFromDisk` clears `isDirty`, so
            // any pending markdown writer self-disarms.
            // Also drop the FM field delta (a separate accumulator).
            dropPendingDelta(rel);
            documentStore.applyReloadFromDisk(
              editorDoc.docId,
              next.content,
              editorDoc.richText,
              next.frontmatter,
              next.rawFrontmatter, // refresh originalFrontmatterCache too
              { mtimeMs: next.lastModified, size: next.rawByteSize },
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
 * What a vault-wide "remove the tiles for a missing file"
 * cascade would touch, computed at toast / confirm time so the copy names the
 * real scope (it spans EVERY board, open ones included — not "closed boards").
 */
function describeMissingFileScope(rel: string): { tiles: number; boardNames: string[] } {
  const targets = boardCacheStore.findCascadeDeleteTargets(rel);
  const boardNames = Object.entries(targets.byBoard)
    .filter(([, ids]) => ids.length > 0)
    .map(([boardId]) => boardCacheStore.cache[boardId]?.board.name || boardId);
  return { tiles: targets.tileIds.length, boardNames };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The cascade is destructive and vault-wide, and its undo lands on whichever
 * board is active, so it only ever runs behind an explicit danger confirm that
 * lists the boards. A click-time re-probe skips it when the file is back on
 * disk (a synced move / trash restore).
 */
function confirmRemoveTilesForMissingFile(rel: string, vaultRoot: string, dropTags: boolean): void {
  const { tiles, boardNames } = describeMissingFileScope(rel);
  if (tiles === 0) return;
  uiStore.openConfirm({
    title: 'Remove tiles for a missing file?',
    body: `This removes ${plural(tiles, 'tile')} and their connections from ${plural(boardNames.length, 'board')}: ${boardNames.join(', ')}. The file itself is already missing. Undo is available on the board that is active when you confirm.`,
    confirmLabel: 'Remove tiles',
    danger: true,
    onConfirm: () => {
      void (async () => {
        try {
          const exists = await window.filo.invoke('vault:file-exists', vaultRoot, rel);
          if (exists) return;
        } catch {
          // Probe failure → treat as still-missing; fall through.
        }
        // The existing undoable cascade (fileSnapshots empty: the file is gone).
        boardStore.cascadeDeleteByVaultPath(rel, {}, vaultRoot);
        // The user confirmed the file is gone; drop its tags.json
        // membership so the orphan entry doesn't linger.
        if (dropTags) fileTagsStore.dropFile(rel);
      })().catch((err) => reportError('missingFile.removeTiles', err, 'Removing the tiles failed.'));
    },
  });
}

/**
 * Toast for an external delete of a `.md`
 * referenced by tiles, with NO open editor for it. On a synced vault this fires
 * for moves and delete-then-recreate too, so the DEFAULT does nothing: "Keep
 * tiles" leaves them showing as missing (the boardRefIntegrity badge is the
 * signal). "Remove N tiles from boards…" opens a danger confirm that lists the
 * boards; only then does the vault-wide cascade run. Sticky + keyed per file,
 * and dismissed when the file reappears (vaultExternalChanges).
 */
export function promptClosedBoardFileMissing(
  rel: string,
  tileCount: number,
  // Anchors the cascade command's vault-swap guard.
  vaultRoot: string,
): void {
  const filename = rel.split('/').pop() || rel;
  const { boardNames } = describeMissingFileScope(rel);
  uiStore.pushToast({
    text: `"${filename}" is missing from the vault (deleted or moved outside Filo). ${plural(tileCount, 'tile')} on ${plural(boardNames.length, 'board')} now show as missing.`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `missing:${rel}`,
    actions: [
      {
        label: 'Keep tiles (show as missing)',
        handler: () => {
          // No-op by design: the tiles keep their broken-ref badge.
        },
      },
      {
        label: `Remove ${plural(tileCount, 'tile')} from boards…`,
        handler: () => confirmRemoveTilesForMissingFile(rel, vaultRoot, true),
      },
    ],
  });
}

/**
 * Apply a freshly re-read disk version to an open editor and
 * its sinks (tile caches, tags, armed field deltas) — the promptModifiedFile
 * Reload trio, for a file that came back after a "deleted externally" prompt.
 */
function applyFreshDiskVersion(rel: string, fresh: FileMetadata, doc: DocumentState): void {
  cancelDirtyGatewayWritersForPath(rel);
  dropPendingDelta(rel);
  documentStore.applyReloadFromDisk(
    doc.docId,
    fresh.content,
    doc.richText,
    fresh.frontmatter,
    fresh.rawFrontmatter,
    { mtimeMs: fresh.lastModified, size: fresh.rawByteSize },
  );
}

/**
 * Cancels every dirty GATEWAY writer armed for `rel` (a Properties popup
 * mid-debounce over this path) and clears its popup-dirty tracker entry.
 * No-op when nothing is dirty.
 *
 * Every Reload handler MUST call this BEFORE it re-anchors the drift baseline:
 * once the baseline matches disk, a surviving armed gateway write would sail
 * past the pre-write drift gate and re-apply the FM rows the user just
 * discarded — including when a dirty popup sits over an open dirty editor.
 */
function cancelDirtyGatewayWritersForPath(rel: string): void {
  for (const callerId of getDirtyInstancesForPath(rel)) {
    cancelMarkdownWrite(callerId);
    clearPropertiesPopupDirty(callerId);
  }
}

/**
 * Toast for a dirty editor whose backing `.md` file was edited externally.
 * The disk frontmatter + tags are applied ONLY when the user picks Reload,
 * never eagerly at prompt-open time (that would clobber the editor's tags
 * even if the user then picks Keep local).
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
export function promptModifiedFile(
  rel: string,
  next: FileMetadata,
  editorDoc: DocumentState,
): void {
  uiStore.pushToast({
    text: `"${editorDoc.title || rel}" was modified externally. Reload from disk, or keep your local edits?`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `ext-mod:${rel}`,
    actions: [
      {
        label: 'Reload',
        // Async so a caller that awaits the action (the toast harness, tests)
        // waits for the disk re-read + apply to land before continuing.
        handler: async () => {
          // Capture identity before the disk re-read; bail after it if a vault
          // swap landed, so the trio below can't write the outgoing vault's
          // content into the new vault.
          const identity = captureVaultIdentity();
          // Re-read the LATEST disk state at click time rather than the
          // detection-time `next` snapshot — a second external write since the
          // toast appeared would otherwise be reverted. If the file vanished in
          // the gap, fall back to `next` (the watcher's delete event handles a
          // genuine removal separately).
          await vaultIndexStore.applyChanges([rel]);
          if (!isStillSameVault(identity)) return;
          const fresh = vaultIndexStore.getMetadata(rel) ?? next;
          // A dirty Properties popup can coexist with the dirty editor; cancel
          // its armed write before the applies re-anchor the drift baseline.
          cancelDirtyGatewayWritersForPath(rel);
          // Atomic trio — match the bulk Reload-all branch.
          // Drop the armed field delta so the reload's
          // flushAllPendingFrontmatterWrites can't re-clobber disk with the
          // edit the user just discarded.
          dropPendingDelta(rel);
          documentStore.applyReloadFromDisk(
            editorDoc.docId,
            fresh.content,
            editorDoc.richText,
            fresh.frontmatter,
            fresh.rawFrontmatter, // refresh originalFrontmatterCache too
            { mtimeMs: fresh.lastModified, size: fresh.rawByteSize },
          );
        },
      },
      {
        label: 'Keep local',
        handler: async () => {
          // Back up the external version to .filo/recovery/ before the
          // overwrite; a declined un-backed-up overwrite is a no-op.
          const identity = captureVaultIdentity();
          const vaultRoot = getActiveVaultPath();
          if (!vaultRoot || !(await backupExternalVersion(vaultRoot, rel))) return;
          if (!isStillSameVault(identity)) return;
          // Mark dirty first so a concurrent reactive-reload $effect can't undo
          // the editor body, then force the registered writer (TextTile or
          // DocumentEditor) to write IMMEDIATELY — if its debounce already
          // fired there is no armed timer and the external edit would persist.
          documentStore.markDirty(editorDoc.docId);
          void forceWriteForDocument(editorDoc.docId);
        },
      },
    ],
  });
}

/**
 * Reload / Keep-local prompt for a path with a pending
 * LOCAL write the editor-based classifier couldn't see. Mirrors
 * `promptBoardChangedExternally` (the board-JSON equivalent).
 *
 * Reload cancels the pending frontmatter write (so it can't re-clobber) and
 * applies the disk frontmatter + tags (plus body when an editor is open).
 * Keep local is a no-op — the pending write fires and overwrites the external
 * edit; an info toast confirms the choice.
 */
export function promptMarkdownPendingWriteConflict(
  rel: string,
  next: FileMetadata,
  editorDoc: DocumentState | null,
): void {
  const label = editorDoc?.title || rel;
  uiStore.pushToast({
    text: `"${label}" was modified externally while you have an unsaved change to it. Reload from disk (discard your change), or keep your change (overwrite on next save)?`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `ext-mod:${rel}`,
    actions: [
      {
        label: 'Reload',
        // Async + click-time disk re-read: replaying the detection-time `next`
        // snapshot would revert a second external write since toast-open.
        handler: async () => {
          // The awaited re-read runs FIRST; the destructive work (write cancel
          // + store applies) runs in the synchronous tail after it, so a
          // rejecting re-read leaves the user's pending edit intact (the error
          // surfaces via `uiStore.invokeToastAction`). The debounce firing
          // during the re-read is fronted by the drift gate + pending-path
          // sentinel.
          //
          // Bail if a vault swap lands during the re-read, before mutating any
          // store (the swap reset disarms the writers itself).
          const identity = captureVaultIdentity();
          const wasIndexed = vaultIndexStore.getMetadata(rel) !== undefined;
          await vaultIndexStore.applyChanges([rel]);
          if (!isStillSameVault(identity)) return;
          // Cancel the armed local frontmatter write and its field delta, plus
          // any dirty GATEWAY writer (a Properties popup over this path).
          // These run BEFORE the deletion early-return below: an armed write
          // left alive would fire against the deleted file (ENOENT, or worse,
          // resurrect it).
          cancelFrontmatterWrite(rel);
          cancelDirtyGatewayWritersForPath(rel);
          // Undefined after re-reading a path that WAS indexed means a DELETION.
          // Skip all store mutations + the baseline stamp — the watcher delete
          // pipeline owns teardown, and the stale `next` would resurrect the
          // metadata. A never-indexed path keeps the `?? next` fallback.
          const reread = vaultIndexStore.getMetadata(rel);
          if (!reread && wasIndexed) return;
          const fresh = reread ?? next;
          if (editorDoc) {
            documentStore.applyReloadFromDisk(
              editorDoc.docId,
              fresh.content,
              editorDoc.richText,
              fresh.frontmatter,
              fresh.rawFrontmatter, // refresh originalFrontmatterCache too
              { mtimeMs: fresh.lastModified, size: fresh.rawByteSize },
            );
          } else {
            // No open editor, so applyReloadFromDisk never re-stamps the drift
            // baseline: re-anchor it here (a stale baseline makes the next
            // in-app save fire a false drift prompt) and drop any
            // seeded-but-not-open FM cache so the next field edit re-seeds
            // from the disk truth the user just accepted.
            noteBaseline(rel, fresh.lastModified, fresh.rawByteSize);
            dropStaleSeededFrontmatterCache(rel);
          }
        },
      },
      {
        label: 'Keep local',
        handler: async () => {
          // Back up the external version before the pending write overwrites it (the drift gate's own backup call dedupes).
          const vaultRoot = getActiveVaultPath();
          if (!vaultRoot || !(await backupExternalVersion(vaultRoot, rel))) return;
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
 * Toast for an external frontmatter-only edit to a file
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
export function promptPropertiesPopupModified(
  rel: string,
  next: FileMetadata,
  // Null when the popup is dirty over a never-loaded doc (no open editor); the
  // editor-only effects (title label, FM-cache refresh) are guarded on it.
  editorDoc: DocumentState | null,
): void {
  const filename = editorDoc?.title || rel;
  uiStore.pushToast({
    text: `Properties of "${filename}" were modified externally while your Properties popup has unsaved edits. Reload from disk (discard popup edits) or keep your local edits?`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `ext-mod:${rel}`,
    actions: [
      {
        label: 'Reload',
        // Async + click-time disk re-read (a second external write since
        // toast-open would otherwise be reverted by the stale `next` snapshot).
        handler: async () => {
          // Re-read FIRST, destructive tail after (see
          // `promptMarkdownPendingWriteConflict`): a rejecting re-read must not
          // drop the popup's pending rows and conflict routing.
          //
          // Bail if a vault swap lands during the re-read.
          const identity = captureVaultIdentity();
          const wasIndexed = vaultIndexStore.getMetadata(rel) !== undefined;
          await vaultIndexStore.applyChanges([rel]);
          if (!isStillSameVault(identity)) return;
          // Undefined after re-reading a path that WAS indexed means a
          // DELETION: skip the store mutations + baseline stamp (the watcher
          // delete pipeline owns teardown). A never-indexed path keeps the
          // `?? next` fallback.
          const reread = vaultIndexStore.getMetadata(rel);
          if (!reread && wasIndexed) return;
          const fresh = reread ?? next;
          // Cancel any popup gateway timer armed for this path before the
          // applies, so a debounce armed for the popup's pre-Reload rows
          // can't overwrite the just-applied external frontmatter. Clearing
          // the tracker entry also stops a still-open popup from re-blocking
          // the next sync-frontmatter for this path.
          cancelDirtyGatewayWritersForPath(rel);
          // Apply external frontmatter trio. The body is unchanged
          // (sync-frontmatter precondition), so applyReloadFromDisk is overkill —
          // setFrontmatter (with rawFrontmatter) refreshes the editor's FM
          // cache AND originalFrontmatterCache.
          // With no open editor there is no FM cache to refresh; the tile-def +
          // tag applies above already carry the external change.
          if (editorDoc) {
            documentStore.setFrontmatter(editorDoc.docId, fresh.frontmatter, fresh.rawFrontmatter);
          }
          // setFrontmatter (unlike applyReloadFromDisk) never re-stamps the
          // drift baseline, so re-anchor it to the accepted disk state and drop
          // any seeded-but-not-open FM cache for sibling cards/rows backed by
          // this path.
          noteBaseline(rel, fresh.lastModified, fresh.rawByteSize);
          dropStaleSeededFrontmatterCache(rel);
        },
      },
      {
        label: 'Keep local',
        handler: async () => {
          // Back up the external version first.
          const vaultRoot = getActiveVaultPath();
          if (!vaultRoot || !(await backupExternalVersion(vaultRoot, rel))) return;
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
export function promptDeletedFile(
  rel: string,
  editorDoc: { docId: string; title: string; body: string },
  ctx: VaultContext,
): void {
  // Snapshot frontmatter + body at toast-open time. If a vault swap or tab
  // close unloads the doc before the Keep-local click, the live cache is gone
  // and the recreated file would land body-only, losing tags / properties.
  const fmSnapshot = { ...(documentStore.getFrontmatter(editorDoc.docId) ?? {}) };
  const bodySnapshot = editorDoc.body;
  uiStore.pushToast({
    text: `"${editorDoc.title || rel}" was deleted externally. Reload (drop in-memory copy), or keep your local edits and re-create the file?`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `ext-deleted:${rel}`,
    actions: [
      {
        label: 'Reload',
        handler: async () => {
          // Probe first: a sync client may have re-created the file since the
          // toast appeared. Then "Reload" means load THAT version, not drop the
          // doc and its tags for a live file.
          const identity = captureVaultIdentity();
          let back = false;
          try {
            back = (await window.filo.invoke('vault:file-exists', ctx.getVaultPath(), rel)) === true;
          } catch {
            back = false;
          }
          if (!isStillSameVault(identity)) return;
          if (back) {
            await vaultIndexStore.applyChanges([rel]);
            if (!isStillSameVault(identity)) return;
            const fresh = vaultIndexStore.getMetadata(rel);
            const live = documentStore.getDocument(editorDoc.docId);
            if (fresh && live) applyFreshDiskVersion(rel, fresh, live);
            return;
          }
          // Drop the in-memory doc — the file is gone, the user wants the
          // delete to win. Pending writers in TextTile / DocumentEditor are
          // self-disarming on ENOENT via `vault:write-existing-file-text`,
          // so we don't need to reach into their debounce timers from here.
          documentStore.unloadDocument(editorDoc.docId);
          // The user accepted the deletion, so drop the file's
          // `.filo/tags.json` membership too; otherwise the orphan entry
          // lingers until the next vault-open prune. (Not on Keep local —
          // that path re-creates the file.)
          fileTagsStore.dropFile(rel);
        },
      },
      {
        label: 'Keep local',
        // allow-keep-local-no-backup: recreateDeletedFile creates exclusively and never overwrites; a reappeared file routes to promptModifiedFile, which backs up
        handler: async () => {
          await recreateDeletedFile(rel, editorDoc, ctx, { fmSnapshot, bodySnapshot }, (fresh) => {
            // The file is back: offer the modified-file choice.
            const live = documentStore.getDocument(editorDoc.docId);
            if (live) promptModifiedFile(rel, fresh, live);
          });
        },
      },
    ],
  });
}
