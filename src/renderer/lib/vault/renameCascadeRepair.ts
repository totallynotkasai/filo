import { boardCacheStore } from '../../stores/boardCache.svelte';
import { boardStore } from '../../stores/board.svelte';
import { fileTagsStore } from '../../stores/fileTags.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { flushScheduledConfig } from '../boards/configWriteScheduler';
import { reportError } from '../utils/errorBus';
import { clearPendingRenameCascade, type RenameCascadeEntry } from './renameCascadeSentinel';
import { isStillSameVault, type VaultIdentity } from './vaultIdentity';
import { renameAllPathKeys } from './renamePathKeys';
import { followRenameInPins } from './folderPins';

/**
 * Where a pending rename stands on disk: `moved` when the old path is gone and
 * the new one exists (the rename happened, so its rewrites can be replayed),
 * `other` when the disk shows something else, `unknown` when a probe failed.
 */
async function renameOnDisk(vaultPath: string, entry: RenameCascadeEntry): Promise<'moved' | 'other' | 'unknown'> {
  try {
    const [oldExists, newExists] = await Promise.all([
      window.filo.invoke('vault:file-exists', vaultPath, entry.oldPath),
      window.filo.invoke('vault:file-exists', vaultPath, entry.newPath),
    ]);
    return oldExists !== true && newExists === true ? 'moved' : 'other';
  } catch {
    return 'unknown';
  }
}

async function clearEntries(vaultPath: string, entries: readonly RenameCascadeEntry[]): Promise<void> {
  for (const entry of entries) {
    await clearPendingRenameCascade(vaultPath, entry.id).catch((err) => {
      reportError('vault.rename-cascade-recovery', err, "Filo couldn't remove its note about a finished rename from .filo/. You may be asked about that rename again when the vault next opens.");
    });
  }
}

/**
 * The recovery prompt's Discard: drop the breadcrumb and change nothing else.
 */
export async function discardRenameCascade(
  entries: readonly RenameCascadeEntry[],
  vaultPath: string,
  captured: VaultIdentity,
): Promise<void> {
  if (!isStillSameVault(captured)) return;
  await clearEntries(vaultPath, entries);
}

/**
 * The recovery prompt's Retry. Re-applies the path rewrites (board refs,
 * path-keyed stores, media tags in `.filo/tags.json`, the Root Directory and
 * board folder pins) for every pending entry
 * whose rename the disk confirms, and clears the breadcrumb on full success.
 * An entry whose old path still exists, or whose new path doesn't, is not
 * replayed: rewriting old → new then would point boards and open notes at a
 * file that isn't there. Its breadcrumb is cleared, since there is nothing to
 * repair; one whose probe failed stays for the next open.
 * `verb` only flavours the failure toasts.
 *
 * Returns the number of board references repaired on success (sentinel
 * cleared), or `null` if a board/tags flush or a path-keyed sweep failed, a
 * probe failed (sentinel kept so the next vault open retries) OR the vault
 * swapped mid-repair.
 *
 * The recovery modal that invokes this is PARKED awaiting a click, and the
 * repair mutates in-memory state across awaits, so the vault can swap before
 * or during it. `captured` (from the recovery sequencer, before the modal
 * opened) is re-checked after each await so the OUTGOING vault's entries are
 * never applied to the NEW vault's cache. Disk writes are main-side gated by
 * `assertActiveVault`; the in-memory mutations are not.
 */
export async function repairRenameCascade(
  allEntries: RenameCascadeEntry[],
  vaultPath: string,
  verb: 'Retry',
  captured: VaultIdentity,
): Promise<number | null> {
  await boardCacheStore.ensureAllLoaded();
  // A swap during the load would apply the outgoing vault's entries to
  // the new vault's cache; bail before any in-memory mutation.
  if (!isStillSameVault(captured)) return null;
  const states = await Promise.all(allEntries.map((e) => renameOnDisk(vaultPath, e)));
  if (!isStillSameVault(captured)) return null;
  const entries = allEntries.filter((_, i) => states[i] === 'moved');
  const notOnDisk = allEntries.filter((_, i) => states[i] === 'other');
  const probeFailed = states.includes('unknown');
  const repairedBoards = new Set<string>();
  let rootMoved = false;
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
      // A pin on the renamed folder (or one inside it) follows, as in the
      // live cascade; otherwise the tree reconcile finds it missing and
      // clears it.
      const pins = followRenameInPins(
        vaultStore.project?.settings.general,
        () => vaultStore.markMetaDirty(),
        entry.oldPath,
        entry.newPath,
      );
      for (const id of pins.boardIds) repairedBoards.add(id);
      if (pins.rootMoved) rootMoved = true;
    } catch (err) {
      reportError(
        'vault.rename-cascade-recovery',
        err,
        `Filo couldn't finish updating board tiles for the rename of "${entry.oldPath}" to "${entry.newPath}". A tile shown as missing can be re-linked.`,
      );
    }
  }
  // Repoint every path-keyed piece of state (open notes, queued writes,
  // tabs), mirroring the normal rename path. The board loop above only fixes
  // `.board.json` references; without this an editor already open when an
  // in-session repair fires keeps writing to the OLD path.
  let pathKeysOk = true;
  for (const entry of entries) {
    if (!renameAllPathKeys(entry.oldPath, entry.newPath)) pathKeysOk = false;
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
  // The Root Directory lives in `app.json`: keep the breadcrumb until it is saved.
  const configFailed = rootMoved ? ((await flushScheduledConfig(() => null))?.failed ?? []) : [];
  if (!isStillSameVault(captured)) return null;
  if (configFailed.length > 0) {
    uiStore.pushToast({
      text: `${verb} updated the board files but couldn't save the Root Directory to .filo/app.json. Reopen the vault to retry.`,
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
  await clearEntries(vaultPath, notOnDisk);
  // A sweep that threw (already reported) left state under an old path, and a
  // failed probe left an entry undecided: keep those breadcrumbs for the next open.
  if (!pathKeysOk || probeFailed) return null;
  await clearEntries(vaultPath, entries);
  return repairedBoards.size;
}
