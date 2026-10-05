/**
 * Opening Settings on a given tab (a notice's "Open Recovery"). The dialog
 * takes the request as it mounts, or, when it is already open, as the request
 * arrives; opened any other way it starts on General, as before.
 */
import { uiStore } from '../../stores/ui.svelte';
import { onVaultSwap } from '../../core/vaultLifecycle';

export type SettingsTab = 'general' | 'defaults' | 'current-board' | 'themes' | 'trash' | 'recovery';

let requested = $state<SettingsTab | null>(null);

// A request the dialog never took goes with the vault it was made in.
onVaultSwap('pre-swap', 'settingsTabRequest', () => {
  requested = null;
});

/** Opens Settings showing `tab`. */
export function openSettingsAt(tab: SettingsTab): void {
  requested = tab;
  uiStore.openModal('project-settings');
}

export const settingsTabRequest = {
  /** The tab asked for and not yet taken (reactive). */
  get requested(): SettingsTab | null {
    return requested;
  },
  /** Takes the request, once. */
  take(): SettingsTab | null {
    const tab = requested;
    requested = null;
    return tab;
  },
};
