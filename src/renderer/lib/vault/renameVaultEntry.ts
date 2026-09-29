import type { FileTreeNode } from '../../../shared/types';
import { vaultStore } from '../../stores/vault.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { samePath, toPosix, toVaultRelative } from '../utils/path';
import { BOARD_FILE_SUFFIX, boardNameFromPath } from '../boards/boardNaming';

/**
 * Renames a sidebar entry to `draft` (already validated by the caller with
 * `fileNameProblem`). When the sidebar hides extensions the user typed only
 * the stem, so the extension is re-attached unless they typed it anyway.
 *
 * A rename never overwrites: main refuses a name another entry already has,
 * so a clash is said up front (OK only) and nothing changes. The same entry
 * under another case (`plan.md` → `Plan.md`) is not a clash, although the
 * existence probe reports it, and is renamed directly.
 */
export async function renameVaultEntry(node: FileTreeNode, draft: string): Promise<void> {
  const ext = node.isDirectory ? '' : node.extension ?? '';
  const finalName = ext && !draft.endsWith(ext) ? draft + ext : draft;
  if (finalName === node.name) return;
  const parentPath = node.path.substring(0, node.path.lastIndexOf(node.name));
  const newAbsPath = parentPath + finalName;

  const vaultRoot = vaultStore.path;
  if (vaultRoot) {
    // Build the vault-relative path the IPC layer expects.
    const newRel = toVaultRelative(newAbsPath, vaultRoot) ?? toPosix(newAbsPath);
    try {
      const exists = await window.filo.invoke('vault:file-exists', vaultRoot, newRel);
      if (exists && !samePath(finalName, node.name)) {
        // A board's file name is its name: refused as everywhere else.
        if (ext === BOARD_FILE_SUFFIX) {
          uiStore.toast(`A board named "${boardNameFromPath(finalName)}" already exists in this folder.`, 'error');
          return;
        }
        await uiStore.confirmAsync({
          title: 'Name already taken',
          body: `"${finalName}" already exists in this folder. Choose another name; nothing was renamed.`,
          confirmLabel: 'OK',
          notice: true,
        });
        return;
      }
    } catch (err) {
      // Probe failure isn't fatal: main refuses a taken name anyway, and the
      // rename's failure is reported below.
      console.warn('[renameVaultEntry] file-exists probe failed:', err);
    }
  }

  const result = await vaultStore.rename(node.path, newAbsPath);
  if (result.success) return;
  if (result.code === 'ENOENT') {
    // Source no longer on disk — silently drop the phantom tree entry.
    await vaultStore.refreshTree();
  } else if (result.strandedAt) {
    // Windows case-only rename exhausted retries AND the rescue restore
    // failed. Name the temp path so the user can recover the file via File
    // Explorer rather than treating the failure as a data loss.
    uiStore.pushToast({
      text: `Rename failed and the file is currently saved as '${result.strandedAt}'. Recover it via File Explorer.`,
      type: 'error',
      duration: 0,
    });
    await vaultStore.refreshTree();
  } else {
    uiStore.toast(`Failed to rename '${node.name}'`, 'error', 3500);
  }
}
