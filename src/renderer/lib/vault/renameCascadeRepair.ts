import { boardCacheStore } from '../../stores/boardCache.svelte';
import { boardStore } from '../../stores/board.svelte';
import { fileTagsStore } from '../../stores/fileTags.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { reportError } from '../utils/errorBus';
import { clearPendingRenameCascade, type RenameCascadeEntry } from './renameCascadeSentinel';
import { isStillSameVault, type VaultIdentity } from './vaultIdentity';
import { renameAllPathKeys } from './renamePathKeys';

/**
 * Shared repair for the rename-cascade recovery
 * sentinel. Re-applies the path rewrites (board refs, path-keyed stores,
 * media tags in `.filo/tags.json`) for every pending entry and clears the
 * breadcrumb on full success.
 *
 * Both the recovery prompt's Retry and Discard handlers run this. Discard
 * repairs too rather than abandoning the boards with broken refs — the
 * renamed file is already on disk, so the only honest outcomes are "repair
 * the pointers" or "leave them broken"; we repair, then the caller confirms
 * what was fixed. `verb` only flavours the failure toasts.
 *
 * Returns the number of board references repaired on success (sentinel
 * cleared), or `null` if a board/tags flush failed (sentinel kept so the next
 * vault open retries the whole cascade) OR the vault swapped mid-repair.
 *
 * The recovery modal that invokes this is PARKED awaiting a click, and the
 * repair mutates in-memory state across awaits, so the vault can swap before
 * or during it. `captured` (from the recovery sequencer, before the modal
 * opened) is re-checked after each await so the OUTGOING vault's entries are
 * never applied to the NEW vault's cache. Disk writes are main-side gated by
 * `assertActiveVault`; the in-memory mutations are not.
 */
export async function repairRenameCascade(
  entries: RenameCascadeEntry[],
  vaultPath: string,
  verb: 'Retry' | 'Discard',
  captured: VaultIdentity,
): Promise<number | null> {
  await boardCacheStore.ensureAllLoaded();
  // A swap during the load would apply the outgoing vault's entries to
  // the new vault's cache; bail before any in-memory mutation.
  if (!isStillSameVault(captured)) return null;
  const repairedBoards = new Set<string>();
  for (const entry of entries) {
    try {
      // Re-apply the moved board's OWN path-key (the `.board.json` file that
      // relocated), not just references TO the renamed file. Usually an
      // idempotent no-op (`loadAllBoards` rescans on open), but keeps recovery
      // self-sufficient if board discovery stops being scan-driven. Mark each moved board dirty so
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
  // Repoint every path-keyed piece of state (open notes, queued writes,
  // tabs), mirroring the normal rename path. The board loop above only fixes
  // `.board.json` references; without this an editor already open when an
  // in-session repair fires keeps writing to the OLD path.
  for (const entry of entries) {
    renameAllPathKeys(entry.oldPath, entry.newPath);
  }
  const flush = await boardCacheStore.flushAllDirty();
  // Re-check after the flush await, before the tag-store mutations below
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
  // Re-assert the media-tag keys in `.filo/tags.json` for every rename, then
  // flush. renameFile/renameFolder are idempotent (no-op when the key already
  // moved before the crash) and the flush is a no-op when nothing changed, so
  // this closes the window between the disk rename and the original tag
  // flush. Keep the sentinel if the tag write fails so the next open retries
  // the whole cascade.
  for (const entry of entries) {
    fileTagsStore.renameFile(entry.oldPath, entry.newPath);
    fileTagsStore.renameFolder(entry.oldPath, entry.newPath);
  }
  const tagFlush = await fileTagsStore.flushPendingSave();
  if (!tagFlush.ok) {
    uiStore.pushToast({
      text: `${verb} updated the board files but failed to persist tag membership to .filo/tags.json. Reopen the vault to retry.`,
      type: 'error',
      duration: 0,
    });
    return null;
  }
  // Re-check before clearing the OLD vault's sentinel: a swap landed
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
