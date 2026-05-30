import { boardCacheStore } from '../../stores/boardCache.svelte';
import { boardStore } from '../../stores/board.svelte';
import { documentStore } from '../../stores/document.svelte';
import { fileTagsStore } from '../../stores/fileTags.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { reportError } from '../utils/errorBus';
import { clearPendingRenameCascade, type RenameCascadeEntry } from './renameCascadeSentinel';

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
 * vault open retries the whole cascade).
 */
export async function repairRenameCascade(
  entries: RenameCascadeEntry[],
  vaultPath: string,
  verb: 'Retry' | 'Discard',
): Promise<number | null> {
  await boardCacheStore.ensureAllLoaded();
  const repairedBoards = new Set<string>();
  for (const entry of entries) {
    try {
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
