/**
 * keepVersion — a copy of a note's text in `.filo/recovery/<ts>-keep/`, which
 * no prune removes. Taken before Filo replaces a version the user may want
 * back: what they typed, before a Reload (or the Raw view's "Use the new
 * version") throws it away, and the longer text before a shrinking reload.
 */
import { invokeOk } from '../utils/invokeOk';

/**
 * Writes `text` as a kept copy of `relPath`. Resolves with the copy's
 * absolute folder, or null when it couldn't be written.
 */
export async function keepNoteVersion(vaultRoot: string, relPath: string, text: string): Promise<string | null> {
  try {
    const kept = await invokeOk('recovery:keep-unsaved', vaultRoot, [{ relPath, text }], 'keep');
    return kept.kept.length > 0 ? `${vaultRoot.replace(/[\\/]+$/, '')}/${kept.dir}` : null;
  } catch (err) {
    console.error('[keepVersion] keeping a copy failed:', err);
    return null;
  }
}
