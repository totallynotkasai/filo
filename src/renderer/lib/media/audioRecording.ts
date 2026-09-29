/**
 * audioRecording — where an Audio tile's recording goes once it stops.
 *
 * A take finishes asynchronously: the recorder's `onstop`, then the blob read,
 * then `media:save-audio`. By then the tile may have unmounted (a tab switch,
 * a pan that culled it, the vault closing), and the board it sits on may no
 * longer be the active one. So everything the save needs is captured when the
 * recording starts: the vault, the board and the folder. The file is linked
 * to that board by id, never to "whatever board is active now", and nothing
 * is linked once the vault has been let go.
 *
 * The component keeps the tile in `recordingTiles` (stores/tiles.svelte.ts)
 * from the start of the take until it stops.
 */
import type { Board } from '../../schema/index';
import { vaultStore } from '../../stores/vault.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { getActiveContentFolder } from '../vault/conventionPaths';
import { captureVaultIdentity, isStillSameVault, type VaultIdentity } from '../vault/vaultIdentity';
import { reportError } from '../utils/errorBus';
import { uiStore } from '../../stores/ui.svelte';

/** Where a take started: saved and linked there, whatever is active when it stops. */
export interface RecordingTarget {
  tileId: string;
  boardId: string;
  vaultRoot: string;
  folder: string;
  identity: VaultIdentity;
}

/** Captured at the start of a take; null when no board or vault is open. */
export function captureRecordingTarget(tileId: string, board: Board | null): RecordingTarget | null {
  const vaultRoot = vaultStore.path;
  if (!board || !vaultRoot) return null;
  return {
    tileId,
    boardId: board.id,
    vaultRoot,
    folder: getActiveContentFolder(board),
    identity: captureVaultIdentity(),
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the recording'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Saves the take and links it to the tile on the board it was recorded on.
 * Resolves to the saved vault path, or null when nothing was linked (the
 * save failed, which is reported, or the vault was let go meanwhile).
 */
export async function saveRecording(target: RecordingTarget, blob: Blob, fileName: string): Promise<string | null> {
  try {
    const data = await blobToBase64(blob);
    if (!isStillSameVault(target.identity)) return null;
    const res = await window.filo.invoke('media:save-audio', target.vaultRoot, data, fileName, target.folder);
    if (!res.success) {
      reportError('AudioTile.save', res.error ?? null, `Failed to save recording "${fileName}"`);
      return null;
    }
    // Saved, but the vault it belongs to is gone: its board can't be written
    // now. The file stays in that vault's folder.
    if (!isStillSameVault(target.identity)) return null;
    // The tile was deleted while it recorded (which ends the take): the file
    // is kept, and the user is told where, rather than left in a folder with
    // nothing pointing at it.
    if (!boardCacheStore.cache[target.boardId]?.tileDefs[target.tileId]) {
      const absPath = `${target.vaultRoot.replace(/[\\/]+$/, '')}/${res.path}`;
      uiStore.pushToast({
        text: `The recording was saved as "${res.path}", but its tile was deleted, so it isn't on a board. Drag it from the sidebar onto a board to use it.`,
        type: 'info',
        duration: 0,
        actions: [{ label: 'Show in folder', handler: () => { void window.filo.invoke('shell:show-item-in-folder', absPath); } }],
      });
      return res.path;
    }
    boardCacheStore.persistUpdateTile(target.tileId, { src: res.path }, target.boardId);
    return res.path;
  } catch (err) {
    reportError('AudioTile.save', err, `Failed to save recording "${fileName}"`);
    return null;
  }
}
