import { boardCacheStore } from '../../stores/boardCache.svelte';
import { boardStore } from '../../stores/board.svelte';
import { documentStore } from '../../stores/document.svelte';
import { fileTagsStore } from '../../stores/fileTags.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { reportError } from '../utils/errorBus';
import { clearPendingRenameCascade, type RenameCascadeEntry } from './renameCascadeSentinel';
import { isStillSameVault, type VaultIdentity } from './vaultIdentity';

/**
 * Phase 4.5 (2026-05-30) — shared repair for the rename-cascade recovery
 * sentinel. Re-applies the board-ref + open-document + `.filo/tags.json`
 * cascade for every pending entry and clears the breadcrumb on full success.
 *
 * Both the recovery prompt's Retry and Discard handlers run this. Discard
 * repairs too rather than abandoning the boards with broken refs — the
 * renamed file is already on disk, so the only honest outcomes are "repair
 * the pointers" or "leave them broken"; we repair, then the caller confirms
 * what was fixed. `verb` only flavours the failure toasts.
 *
 * Extracted from vault.svelte.ts (Phase 4 file-size ratchet) — it depends on
 * no vault-store module-private state, only the shared store singletons and
 * the sentinel writer, so it lives cleanly in `lib/vault/`.
 *
 * Returns the number of board references repaired on success (sentinel
 * cleared), or `null` if a board/tags flush failed (sentinel kept so the next
 * vault open retries the whole cascade) OR the vault swapped mid-repair (VS-1).
 *
 * Audit-11 VS-1 — the recovery modal that invokes this is PARKED awaiting a
 * user click, and the repair itself runs in-memory mutations across awaits, so
 * the active vault can swap before the click OR during the repair. The
 * generation-aware `captured` identity is threaded from the recovery sequencer
 * (captured against the vault this cascade belongs to, before the modal opened),
 * and re-checked after each await before any in-memory mutation. Without it a
 * swap would inject the OUTGOING vault's rename entries into the NEW vault's
 * board/doc cache. The disk writes below are main-side gated by
 * `assertActiveVault`; the in-memory mutations are not.
 */
export async function repairRenameCascade(
  entries: RenameCascadeEntry[],
  vaultPath: string,
  verb: 'Retry' | 'Discard',
  captured: VaultIdentity,
): Promise<number | null> {
  await boardCacheStore.ensureAllLoaded();
  // VS-1 — a swap during the load would apply the outgoing vault's entries to
  // the new vault's cache; bail before any in-memory mutation.
  if (!isStillSameVault(captured)) return null;
  const repairedBoards = new Set<string>();
  for (const entry of entries) {
    try {
      // A9-L9 — re-apply the moved board's OWN path-key (the `.board.json` file
      // that relocated), not just references TO the renamed file. Today
      // `loadAllBoards` rescans the tree on every open, so the freshly-loaded
      // cache already holds the new path and this is an idempotent no-op
      // (returns []); the call makes recovery self-sufficient if board
      // discovery ever stops being scan-driven. Mark each moved board dirty so
      // the `flushAllDirty` below rewrites it under its new name (mirrors the
      // live cascade's renameBoardPath → markDirty step).
      for (const id of boardCacheStore.renameBoardPath(entry.oldPath, entry.newPath)) {
        boardCacheStore.markDirty(id);
        repairedBoards.add(id);
      }
      for (const id of boardStore.propagateRename(entry.oldPath, entry.newPath)) {
        repairedBoards.add(id);
      }
    } catch (err) {
      reportError(
        'vault.rename-cascade-recovery',
        err,
        `Failed to re-apply rename cascade for ${entry.oldPath} → ${entry.newPath}`,
      );
    }
  }
  // Phase 4.4 — repoint any open document, mirroring the normal rename path.
  // The board loop above only fixes `.board.json` references; without this an
  // editor already open when an in-session repair fires keeps writing to the
  // OLD path, resurrecting it via mkdir-recursive on the next autosave.
  for (const entry of entries) {
    documentStore.propagateRename(entry.oldPath, entry.newPath);
  }
  const flush = await boardCacheStore.flushAllDirty();
  // VS-1 — re-check after the flush await, before the tag-store mutations below
  // (renameFile/renameFolder are in-memory). A swap here means the old vault's
  // board flush already landed (main-gated); just stop before touching tags.
  if (!isStillSameVault(captured)) return null;
  if (flush.failed.length > 0) {
    uiStore.pushToast({
      text: `${verb} partially succeeded — ${flush.failed.length} board file${flush.failed.length === 1 ? '' : 's'} still failed: ${flush.failed.join(', ')}. Open each board and re-save manually.`,
      type: 'error',
      duration: 0,
    });
    return null;
  }
  // E5 — re-assert the `.filo/tags.json` sink for every rename that touched
  // it, then flush. renameFile/renameFolder are idempotent (no-op when the
  // key already moved before the crash), so this safely closes the window
  // between the disk rename and the original synchronous tag flush (F3)
  // regardless of which side a crash interrupted. Keep the sentinel if the
  // tag write fails so the next open retries the whole cascade.
  let tagsReasserted = false;
  for (const entry of entries) {
    if (!entry.tagsAffected) continue;
    fileTagsStore.renameFile(entry.oldPath, entry.newPath);
    fileTagsStore.renameFolder(entry.oldPath, entry.newPath);
    tagsReasserted = true;
  }
  if (tagsReasserted) {
    const tagFlush = await fileTagsStore.flushPendingSave();
    if (!tagFlush.ok) {
      uiStore.pushToast({
        text: `${verb} updated the board files but failed to persist tag membership to .filo/tags.json. Reopen the vault to retry.`,
        type: 'error',
        duration: 0,
      });
      return null;
    }
  }
  // VS-1 — re-check before clearing the OLD vault's sentinel: a swap landed
  // during the tag flush, so keep the breadcrumb (the next open of that vault
  // retries) rather than clearing it from the new vault's context.
  if (!isStillSameVault(captured)) return null;
  for (const entry of entries) {
    await clearPendingRenameCascade(vaultPath, entry.id).catch((err) => {
      reportError(
        'vault.rename-cascade-recovery',
        err,
        'Failed to clear rename-cascade sentinel after a successful repair',
      );
    });
  }
  return repairedBoards.size;
}
