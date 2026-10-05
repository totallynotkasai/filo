/**
 * A file picked in the system's file dialog for a card cover, a File tile or
 * a background image. One already in the vault is linked by its path, as a
 * file dropped from Explorer is: copying it would leave a second
 * `photo (1).jpg` beside it. Only a file from outside the vault is copied in.
 *
 * A pick from a hidden folder in the vault (`.filo`, `.git`, a sync client's
 * versions folder) is copied too: the sidebar doesn't show those folders,
 * Filo won't read inside `.filo`, and what they hold is pruned or emptied
 * without asking.
 */
import { copyFileIntoVault } from './vaultOperations';
import { toVaultRelative } from '../utils/path';
import { isInHiddenFolder } from './droppedFiles';

export type PickedFileResult =
  | { success: true; relPath: string; linked: boolean }
  | { success: false; error: string };

/** Links `sourcePath` when it is in the vault, else copies it into `folder`. */
export async function bringPickedFileIn(sourcePath: string, vaultRoot: string, folder: string): Promise<PickedFileResult> {
  const rel = toVaultRelative(sourcePath, vaultRoot);
  if (rel && !isInHiddenFolder(rel)) return { success: true, relPath: rel, linked: true };
  const res = await copyFileIntoVault(sourcePath, vaultRoot, folder);
  if (!res.success) return { success: false, error: res.error ?? 'unknown error' };
  const stored = res.relativePath || res.path || '';
  return stored ? { success: true, relPath: stored, linked: false } : { success: false, error: 'no path came back' };
}
