/**
 * Open a vault the user picks, from Home, the vault menu or Ctrl+O.
 *
 * The switch itself is `vaultStore.openVault`, which saves the outgoing
 * vault first and asks if anything is left unsaved; this only adds the
 * folder picker and the recent-vaults entry, so every way in behaves alike.
 */
import { vaultStore } from './vault.svelte';
import { invokeOk } from '../lib/utils/invokeOk';

export interface RecentVault {
  name: string;
  path: string;
  lastOpened: number;
  pinned?: boolean;
}

/**
 * Ask for a folder and open it. Resolves true once the vault is open; false
 * when the picker was dismissed, the user stayed in the current vault, or the
 * open failed (which has already reported itself).
 */
export async function pickAndOpenVault(): Promise<boolean> {
  const path = await window.filo.invoke('vault:select');
  if (!path) return false;
  const loaded = await vaultStore.openVault(path);
  if (loaded) await rememberOpenVault();
  return loaded;
}

/**
 * Put the open vault at the top of the recent list. Returns the new list, or
 * null when it couldn't be recorded: the list is convenience state, so a
 * failure (a network share briefly offline) leaves the shown list as it was.
 */
export async function rememberOpenVault(): Promise<RecentVault[] | null> {
  const path = vaultStore.path;
  const name = vaultStore.projectName;
  if (!path || !name) return null;
  try {
    const { recents } = await invokeOk('vault:add-recent', path, name);
    return recents;
  } catch {
    return null;
  }
}
