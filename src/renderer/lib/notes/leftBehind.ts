/**
 * leftBehind — the last line behind the save before leaving a vault.
 *
 * Leaving hands over what every view holds, saves, and only then lets the
 * swap unmount the views and reset the note writer. A note change still
 * queued when a vault is let go as saved was made after that save, which
 * means something in the leave sequence regressed. Resetting the writer would
 * drop it silently, so it is copied to `.filo/recovery/` first and the crash
 * sentinel is set again: reopening the vault offers it.
 */
import { invokeOk } from '../utils/invokeOk';
import { reportError } from '../utils/errorBus';
import { markDirty } from '../vault/dirtyFlagRecovery';

export async function keepLeftBehind(
  vaultRoot: string,
  texts: ReadonlyArray<{ relPath: string; text: string }>,
): Promise<void> {
  if (texts.length === 0) return;
  const paths = texts.map((t) => t.relPath);
  console.error('[noteStore] note changes were queued after the save before leaving:', paths);
  try {
    await invokeOk('recovery:keep-unsaved', vaultRoot, [...texts]);
  } catch (err) {
    reportError('noteStore.leftBehind', err, `Couldn't keep a copy of the unsaved changes to ${paths.join(', ')}`);
  }
  await markDirty(vaultRoot, paths);
}
