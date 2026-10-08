/**
 * Making a note or a folder from the vault sidebar: its toolbar's New button
 * (a note or a folder), and New note / New folder on a folder's menu or on
 * the empty space below the files (the vault's top).
 *
 * What is made shows at once: the tag filter and the name search are cleared
 * first (an empty folder or an "Untitled" note matches neither), and the
 * folder it lands in opens.
 */
import type { FileTreeNode } from '../../../shared/types';
import { vaultStore } from '../../stores/vault.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { sidebarTagFilter } from '../../stores/sidebarTagFilter.svelte';
import { pathsEqualExact, samePath, toVaultRelative } from '../utils/path';
import { createNewNote } from '../notes/newNote';

function findNode(nodes: readonly FileTreeNode[], abs: string): FileTreeNode | null {
  for (const n of nodes) {
    if (pathsEqualExact(n.path, abs)) return n;
    if (n.children) {
      const inside = findNode(n.children, abs);
      if (inside) return inside;
    }
  }
  return null;
}

/** Clears the filters and opens `folderAbs` (nothing to open at the vault's top). */
function showFolder(folderAbs: string): void {
  sidebarTagFilter.clear();
  vaultStore.setSearch('');
  if (samePath(folderAbs, vaultStore.path)) return;
  if (!sidebarTagFilter.isFolderExpanded(folderAbs)) sidebarTagFilter.toggleFolder(folderAbs);
}

/**
 * Makes "New Folder" (or the next free name) in `parentAbs`, an absolute tree
 * path, and opens its name for typing in the sidebar.
 */
export async function newFolderIn(parentAbs: string): Promise<void> {
  if (!vaultStore.path) return;
  showFolder(parentAbs);
  const name = await vaultStore.suggestFolderName(parentAbs, 'New Folder');
  const result = await vaultStore.createFolder(parentAbs, name);
  if (!result.success) {
    // Main's refusal (EACCES, a name taken since the suggestion, a swapped
    // vault) is shown, so the user sees why no row appeared.
    uiStore.toast(`Couldn't create folder "${name}"${result.code ? ` (${result.code})` : ''}`, 'error', 4000);
    return;
  }
  // The row matches on its exact tree path, and the tree keeps the platform's
  // separators (backslashes on Windows), so take the spelling from the
  // refreshed tree rather than the one joined here.
  const newAbs = `${parentAbs.replace(/[\\/]+$/, '')}/${name}`;
  uiStore.setPendingSidebarRenameId(findNode(vaultStore.rawTree, newAbs)?.path ?? newAbs);
}

/** Makes a note in `folderAbs`, an absolute tree path, and opens it with its title ready to type. */
export async function newNoteIn(folderAbs: string): Promise<void> {
  if (!vaultStore.path) return;
  showFolder(folderAbs);
  await createNewNote(toVaultRelative(folderAbs, vaultStore.path) ?? '');
}
