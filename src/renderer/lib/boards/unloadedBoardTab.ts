/**
 * Retry for a tab kept open while its board couldn't load. A board that loads
 * takes the tab over (`tabStore.resolveUnloaded`, run by the adoption); one
 * whose file is gone closes its tab, as a deleted board's tab does.
 */
import { adoptBoardAtRuntime, lastAdoptFailure } from '../../stores/boardDiscovery';
import { unloadedBoardMessage } from '../../stores/unloadedBoards';
import { tabStore, type TabData } from '../../stores/tabs.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { captureVaultIdentity } from '../vault/vaultIdentity';

export type UnloadedRetryResult =
  | { kind: 'loaded' }
  | { kind: 'gone' }
  | { kind: 'failed'; message: string };

/** Why the tab's board isn't loaded, when that is known. */
export function unloadedTabMessage(tab: TabData): string {
  return tab.unloadedPath ? unloadedBoardMessage(tab.unloadedPath) ?? '' : '';
}

export async function retryUnloadedBoard(tab: TabData): Promise<UnloadedRetryResult> {
  const relPath = tab.unloadedPath;
  const identity = captureVaultIdentity();
  if (!relPath || !identity.path) return { kind: 'failed', message: '' };
  let exists = true;
  try {
    exists = (await window.filo.invoke('vault:file-exists', identity.path, relPath)) !== false;
  } catch {
    // A failed probe proves nothing; the load below says what is wrong.
  }
  if (!exists) {
    uiStore.toast(`"${relPath}" is no longer in the vault, so its tab was closed.`, 'info', 4000);
    await tabStore.close(tab.id);
    return { kind: 'gone' };
  }
  const outcome = await adoptBoardAtRuntime(relPath, identity);
  if (outcome === 'adopted' || outcome === 'already' || outcome === 'renamed') return { kind: 'loaded' };
  return {
    kind: 'failed',
    message: outcome === 'duplicate'
      ? 'Another board file uses the same id.'
      : lastAdoptFailure(relPath)?.message ?? unloadedTabMessage(tab),
  };
}
