/**
 * Vault slice — external-edit USER PROMPTS (extracted from
 * `vaultExternalChanges.ts`, Audit-15 P5.1).
 *
 * The external-change dispatcher in `vaultExternalChanges.ts` classifies a
 * watcher event and then, for the cases needing a human decision, calls one of
 * the Reload / Keep-local / delete / recreate toast builders defined here. They
 * were split out to keep the dispatcher under the file-size ceiling; the move is
 * a pure relocation — every function keeps its name, signature, behaviour, and
 * (where it had one) `export`.
 *
 * Dependency direction: the dispatcher imports these builders; NOTHING here
 * imports back into the dispatcher, the rename cascade, or the slice — every
 * builder takes the already-captured `VaultContext` / identity as an argument —
 * so the split introduces no new module cycle.
 *
 * The per-path in-flight drift-prompt registry (`inFlightDriftPrompts`) and its
 * vault-swap reset + rename-transfer registrations moved here WITH their only
 * users (`promptExternalEditOnSync` / `promptBoardExternalEdit`), keeping the
 * exact subscriber names so the lifecycle/rename wiring is unchanged. The
 * deferred `queueMicrotask` that registers the prompts with the markdown / board
 * writers (via setters, to dodge the lib->store import cycle) also moved here; it
 * runs when the dispatcher imports this module.
 *
 * The `prompt*` builders that re-read disk via `vaultIndexStore.applyChanges()`
 * and then mutate stores are covered by `scripts/check-reconciler-vault-guard.mjs`,
 * whose GUARD_TARGETS scans THIS file with the same triggers/exemption the
 * dispatcher carried.
 */
import type { FileMetadata } from '../lib/vault/vaultIndex';
import { vaultIndexStore } from './vaultIndex.svelte';
import { documentStore } from './document.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { boardStore } from './board.svelte';
import { uiStore } from './ui.svelte';
import { normalizeTags } from '../lib/vault/frontmatterSync';
import { cancelFrontmatterWrite, dropPendingDelta } from '../lib/boards/frontmatterWriteScheduler';
import { forceWriteForDocument, cancelMarkdownWrite } from '../lib/vault/markdownFileWriter';
import {
  getDirtyInstancesForPath,
  clearPropertiesPopupDirty,
} from '../lib/vault/propertiesPopupTracker';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
// Audit-16 6.3 — the click-time-reload no-editor branch re-anchors the drift
// baseline + drops the seeded-but-not-open FM cache (the applyReloadFromDisk
// path does both internally; the no-editor / setFrontmatter paths must not skip them).
import { noteBaseline } from '../lib/vault/fileBaselineRegistry';
import { dropStaleSeededFrontmatterCache } from '../lib/vault/staleSeededFrontmatter';
import type { DocumentState } from './document.svelte';
import type { VaultContext } from './vaultStoreTypes';
// Audit-15 P5.1 — `recreateDeletedFile` (the Keep-local recovery write) lives in
// the drift-prompt sibling; the bulk + single deleted-file toasts here invoke it.
import { recreateDeletedFile } from './vaultExternalDriftPrompts';

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
export function promptExternalAttachmentDeleted(
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

export type PendingPrompt =
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
export function promptBulkExternalChanges(prompts: PendingPrompt[], ctx: VaultContext): void {
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
        // Async so the toast harness / tests wait for the per-file disk
        // re-reads to land before continuing (mirrors promptModifiedFile).
        handler: async () => {
          // L17 (Audit-13) — capture identity before the per-file disk re-reads;
          // a vault swap during any `applyChanges` await would otherwise apply the
          // outgoing vault's disk content to the new vault's same-named stores.
          const identity = captureVaultIdentity();
          for (const p of prompts) {
            if (p.kind === 'modified') {
              // L3 (Audit-12) — re-read the LATEST disk state per file at click
              // time instead of replaying the `p.next` snapshot captured when
              // the watcher event first fired. A SECOND external write landing
              // between detection and the user's click would otherwise make
              // "Reload all" apply the stale first-detection content. Mirrors
              // the now-hardened single-file `promptModifiedFile` Reload; fall
              // back to `p.next` if the file vanished in the gap.
              await vaultIndexStore.applyChanges([p.rel]);
              // L17 (Audit-13) — bail if a swap landed during the re-read, before
              // mutating any store with the outgoing vault's disk content.
              if (!isStillSameVault(identity)) return;
              const fresh = vaultIndexStore.getMetadata(p.rel) ?? p.next;
              // Phase 3 / 3.3 — apply the deferred frontmatter + tag updates
              // atomically with the body reload so reload-all lands in a
              // consistent state.
              boardStore.applyFrontmatterToBackedTiles(p.rel, fresh);
              fileTagsStore.setFileTags(p.rel, normalizeTags(fresh.frontmatter.tags));
              // Audit-11 EER-1 — discard any armed field delta BEFORE the reload,
              // else applyReloadFromDisk's flushAllPendingFrontmatterWrites would
              // re-apply the discarded edit to fresh disk and revert this reload.
              dropPendingDelta(p.rel);
              documentStore.applyReloadFromDisk(
                p.editorDoc.docId,
                fresh.content,
                p.editorDoc.richText,
                fresh.frontmatter,
                fresh.rawFrontmatter, // L1 (Audit-13) — refresh originalFrontmatterCache too
                { mtimeMs: fresh.lastModified, size: fresh.rawByteSize },
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
              // H3 (Audit-7) — mirror the single-file Keep-local path
              // (promptModifiedFile). The previous `flushAllMarkdownWrites` drains
              // only armed timers — never `forceWriters` — so a doc whose 300ms
              // debounce already fired wrote nothing and the external bytes
              // survived "keep mine". markDirty first (so a concurrent reactive
              // reload can't undo the body), then `forceWriteForDocument` commits
              // the live editor body even with no armed debounce.
              documentStore.markDirty(p.editorDoc.docId);
              void forceWriteForDocument(p.editorDoc.docId);
            } else {
              // Phase B / B.5 — pass the snapshot captured at toast-open
              // so a parallel unload between then and now doesn't drop
              // the doc's frontmatter on the floor.
              void recreateDeletedFile(p.rel, p.editorDoc, ctx, deletedSnapshots.get(p.editorDoc.docId));
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
          // L17 (Audit-13) — capture identity before the disk re-read so a vault
          // swap during it can't apply the outgoing vault's content to the new
          // vault's stores. (Sibling of the bulk Reload-all / promptModifiedFile
          // Reload handlers.)
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
          boardStore.applyFrontmatterToBackedTiles(rel, next);
          fileTagsStore.setFileTags(rel, normalizeTags(next.frontmatter.tags));
          if (editorDoc) {
            // Phase 3 / 3.2 — bypass the dirty-editor prompt entirely:
            // the user just clicked Reload, so we apply unconditionally.
            // `applyReloadFromDisk` clears `isDirty` so any pending
            // markdown writer drops its outstanding scheduled write
            // (the writer self-disarms when the doc transitions to
            // clean).
            // Audit-11 EER-1 — also drop the FM field delta (separate accumulator).
            dropPendingDelta(rel);
            documentStore.applyReloadFromDisk(
              editorDoc.docId,
              next.content,
              editorDoc.richText,
              next.frontmatter,
              next.rawFrontmatter, // L1 (Audit-13) — refresh originalFrontmatterCache too
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
 * Phase 31 B2.5 — toast for an external delete of a file referenced by
 * tile(s) on at least one board, with NO open editor for it. The "Mark
 * broken refs" action runs the existing cascade-delete walk so every
 * referencing tile gets removed (with undo, via the existing command);
 * "Dismiss" leaves the broken refs in place so the user can attempt a
 * restore (e.g. recover from trash) without losing their tile layout.
 */
export function promptClosedBoardFileMissing(
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
export function promptModifiedFile(
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
        // Async so a caller that awaits the action (the toast harness, tests)
        // waits for the disk re-read + apply to land before continuing.
        handler: async () => {
          // L17 (Audit-13) — capture identity before the disk re-read; bail after
          // it if a vault swap landed, so the trio below can't write the outgoing
          // vault's content into the new vault.
          const identity = captureVaultIdentity();
          // Phase 3 / 3.4 — re-read the LATEST disk state at click time
          // instead of replaying the `next` snapshot captured when the
          // watcher event first fired. A SECOND external write landing
          // between the toast appearing and the user's click would otherwise
          // make "Reload from disk" apply the already-stale first-detection
          // content. Mirrors the fresh-read Reload in
          // `promptExternalEditOnSync`. If the file vanished in the gap, fall
          // back to the captured `next` so the trio still has coherent bytes
          // (the watcher's delete event handles a genuine removal separately).
          await vaultIndexStore.applyChanges([rel]);
          if (!isStillSameVault(identity)) return;
          const fresh = vaultIndexStore.getMetadata(rel) ?? next;
          // Atomic trio — match the bulk Reload-all branch.
          boardStore.applyFrontmatterToBackedTiles(rel, fresh);
          fileTagsStore.setFileTags(rel, normalizeTags(fresh.frontmatter.tags));
          // Audit-11 EER-1 — drop the armed field delta so the reload's
          // flushAllPendingFrontmatterWrites can't re-clobber disk with the
          // edit the user just discarded.
          dropPendingDelta(rel);
          documentStore.applyReloadFromDisk(
            editorDoc.docId,
            fresh.content,
            editorDoc.richText,
            fresh.frontmatter,
            fresh.rawFrontmatter, // L1 (Audit-13) — refresh originalFrontmatterCache too
            { mtimeMs: fresh.lastModified, size: fresh.rawByteSize },
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
    actions: [
      {
        label: 'Reload',
        // Audit-16 6.3 — async + click-time disk re-read, mirroring
        // promptModifiedFile: replaying the detection-time `next` snapshot
        // would apply already-stale content when a SECOND external write
        // landed between toast-open and the click.
        handler: async () => {
          // Audit-17 2.5 — the awaited re-read runs FIRST; the destructive
          // work (write cancel + store applies) runs in the synchronous tail
          // AFTER it. The prior 6.3 ordering cancelled the armed frontmatter
          // write up front, so a rejecting re-read left the user's pending
          // edit cancelled AND the reload never applied — a destructive
          // prefix on a failed action. With the re-read first, a failure
          // leaves everything intact (the toast-action catch in
          // `uiStore.invokeToastAction` surfaces it). The trade-off this
          // inverts — the ~300 ms debounce firing DURING the re-read and the
          // fresh read adopting the user's own discarded change as the
          // "external" version — is fronted by the drift gate + pending-path
          // sentinel and was weighed in the Audit-17 review (refuted
          // finding #5); the cancel lands in the same synchronous tail as
          // the applies, so no further async gap exists after the read.
          //
          // L17 (Audit-13) shape — bail if a vault swap lands during the
          // re-read, before mutating any store with the outgoing vault's
          // disk content (the swap reset disarms the writers itself).
          const identity = captureVaultIdentity();
          const wasIndexed = vaultIndexStore.getMetadata(rel) !== undefined;
          await vaultIndexStore.applyChanges([rel]);
          if (!isStillSameVault(identity)) return;
          // Audit-17 5.6(b) — undefined after the targeted re-read of a path
          // that WAS indexed means applyChanges processed a DELETION (file
          // gone). Skip all store mutations + the baseline stamp — the watcher
          // delete pipeline owns teardown, and the stale `next` snapshot would
          // resurrect deleted-file metadata and re-anchor a baseline for a
          // vanished path. A path that was NEVER indexed (transient — a
          // never-loaded doc the index hadn't built) keeps the documented
          // `?? next` fallback.
          const reread = vaultIndexStore.getMetadata(rel);
          if (!reread && wasIndexed) return;
          const fresh = reread ?? next;
          // Cancel the still-armed local frontmatter write AND drop its
          // Phase-4 field delta (Audit-11 EER-1) before the applies, so the
          // debounce can't fire after the reload and re-clobber disk with
          // the change the user just discarded.
          cancelFrontmatterWrite(rel);
          boardStore.applyFrontmatterToBackedTiles(rel, fresh);
          fileTagsStore.setFileTags(rel, normalizeTags(fresh.frontmatter.tags));
          if (editorDoc) {
            documentStore.applyReloadFromDisk(
              editorDoc.docId,
              fresh.content,
              editorDoc.richText,
              fresh.frontmatter,
              fresh.rawFrontmatter, // L1 (Audit-13) — refresh originalFrontmatterCache too
              { mtimeMs: fresh.lastModified, size: fresh.rawByteSize },
            );
          } else {
            // Audit-17 5.6(a) — FIRST cancel any surviving GATEWAY writer armed
            // for this path (a dirty Properties popup over this never-loaded
            // doc): without this, re-anchoring the baseline below would let that
            // armed write sail past the pre-write drift gate (its baseline now
            // matches disk) and clobber the delta's FM keys with the rows the
            // user just discarded. Mirrors the sibling Reload handlers
            // (promptPropertiesPopupModified / promptBulkExternalChanges).
            for (const callerId of getDirtyInstancesForPath(rel)) {
              cancelMarkdownWrite(callerId);
              clearPropertiesPopupDirty(callerId);
            }
            // Audit-16 6.3 — no open editor: applyReloadFromDisk (which
            // re-stamps the drift baseline via its diskIdentity arg) never
            // runs, so re-anchor the per-file baseline here (A8-M2 shape —
            // a stale baseline makes the NEXT in-app save fire a false
            // drift prompt) and drop any seeded-but-not-open FM cache so
            // the next field edit re-seeds from the disk truth the user
            // just accepted.
            noteBaseline(rel, fresh.lastModified, fresh.rawByteSize);
            dropStaleSeededFrontmatterCache(rel);
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
export function promptPropertiesPopupModified(
  rel: string,
  next: FileMetadata,
  // Audit-17 5.8 — nullable: the dispatcher also routes here when a Properties
  // popup is dirty over a NEVER-loaded doc (no open editor), where `editorDoc`
  // is null. The prompt only needs `rel` + metadata; the editor-only effects
  // (title label, FM-cache refresh) are guarded on `editorDoc` presence.
  editorDoc: DocumentState | null,
): void {
  const filename = editorDoc?.title || rel;
  uiStore.pushToast({
    text: `Properties of "${filename}" were modified externally while your Properties popup has unsaved edits. Reload from disk (discard popup edits) or keep your local edits?`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Reload',
        // Audit-16 6.3 — async + click-time disk re-read, mirroring
        // promptModifiedFile (a second external write between toast-open and
        // the click would otherwise be reverted by the stale `next` snapshot).
        handler: async () => {
          // Audit-17 2.5 — re-read FIRST, destructive tail after (mirrors the
          // `promptMarkdownPendingWriteConflict` Reload reorder; see the full
          // rationale there). The prior 6.3 ordering cancelled the popup's
          // armed gateway writes + cleared the dirty tracker up front, so a
          // rejecting re-read dropped the popup's pending rows AND its
          // conflict routing while the reload never applied.
          //
          // L17 (Audit-13) shape — bail if a vault swap lands during the re-read.
          const identity = captureVaultIdentity();
          const wasIndexed = vaultIndexStore.getMetadata(rel) !== undefined;
          await vaultIndexStore.applyChanges([rel]);
          if (!isStillSameVault(identity)) return;
          // Audit-17 5.6(b) — undefined after the targeted re-read of a path
          // that WAS indexed means applyChanges processed a DELETION (file
          // gone). Skip the store mutations + baseline stamp; the watcher
          // delete pipeline owns teardown. A never-indexed path (transient)
          // keeps the documented `?? next` fallback.
          const reread = vaultIndexStore.getMetadata(rel);
          if (!reread && wasIndexed) return;
          const fresh = reread ?? next;
          // Cancel any popup gateway timer armed for this path before the
          // applies, so a debounce armed for the popup's pre-Reload rows
          // can't fire moments later and overwrite the just-applied external
          // frontmatter. Clearing the tracker entry is also defensive — a
          // still-open popup that hadn't yet typed further would otherwise
          // re-block the next sync-frontmatter for this path.
          for (const callerId of getDirtyInstancesForPath(rel)) {
            cancelMarkdownWrite(callerId);
            clearPropertiesPopupDirty(callerId);
          }
          // Apply external frontmatter trio. The body is unchanged
          // (sync-frontmatter precondition), so applyReloadFromDisk is overkill —
          // setFrontmatter (with rawFrontmatter, P2.1) refreshes the editor's FM
          // cache AND originalFrontmatterCache (mirrors the L1/L13 sibling sites).
          boardStore.applyFrontmatterToBackedTiles(rel, fresh);
          fileTagsStore.setFileTags(rel, normalizeTags(fresh.frontmatter.tags));
          // Audit-17 5.8 — guard on docId presence: with no open editor (the
          // never-loaded-doc popup case) there is no FM cache to refresh; the
          // tile-def + tag applies above already carry the external change.
          if (editorDoc) {
            documentStore.setFrontmatter(editorDoc.docId, fresh.frontmatter, fresh.rawFrontmatter);
          }
          // Audit-16 6.3 — setFrontmatter (unlike applyReloadFromDisk) never
          // re-stamps the drift baseline, so re-anchor it to the accepted disk
          // state (A8-M2 shape) and drop any seeded-but-not-open FM cache for
          // sibling cards/rows backed by this path.
          noteBaseline(rel, fresh.lastModified, fresh.rawByteSize);
          dropStaleSeededFrontmatterCache(rel);
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
export function promptDeletedFile(
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
