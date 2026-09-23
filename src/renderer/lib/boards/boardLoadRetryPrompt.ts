/**
 * Audit-19 ERR-4 — the actionable notice for a board that couldn't be read at
 * vault open because the file was locked (OneDrive / antivirus), online-only
 * while offline, or hit a transient IO error. Before, it read as "not-found"
 * and the board was gone for the session; the only way back was reopening the
 * vault.
 *
 * Sticky (it stays until acted on), keyed per board path, with a Retry that
 * adopts the board into the running session (`adoptBoardAtRuntime`, loaded
 * lazily so this lib module stays out of the store import graph). A retry that
 * fails again re-shows the notice with the fresh reason.
 */
import { uiStore } from '../../stores/ui.svelte';
import { captureVaultIdentity } from '../vault/vaultIdentity';

export interface BoardLoadRetryToast {
  text: string;
  type: 'warning';
  duration: number;
  sticky: true;
  dedupeKey: string;
  actions: Array<{ label: string; handler: () => Promise<void> }>;
}

/** Shows the notice now (a runtime retry that failed again). */
export function promptBoardLoadRetry(vaultRoot: string, relPath: string, message: string): void {
  uiStore.pushToast(boardLoadRetryToast(vaultRoot, relPath, message));
}

/**
 * The notice as a toast spec, so the vault-open candidate can BUFFER it and the
 * commit shows it (a candidate that fails to open leaves no toast behind).
 */
export function boardLoadRetryToast(vaultRoot: string, relPath: string, message: string): BoardLoadRetryToast {
  return {
    text: `${message} Retry once it's available. Your other boards are open as normal.`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `board-load:${relPath}`,
    actions: [
      {
        label: 'Retry',
        handler: async () => {
          const identity = captureVaultIdentity();
          if (identity.path !== vaultRoot) return; // a different vault is open now
          const { adoptBoardAtRuntime, lastAdoptFailure } = await import('../../stores/boardDiscovery');
          const outcome = await adoptBoardAtRuntime(relPath, identity);
          if (outcome === 'failed') {
            const again = lastAdoptFailure(relPath);
            if (again?.transient) promptBoardLoadRetry(vaultRoot, relPath, again.message);
          }
        },
      },
    ],
  };
}
