import { vaultStore } from './vault.svelte';
import { safeVaultColor } from '../../shared/vaultColor';

/**
 * The open vault's colour, or '' for none. Reactive when read in a
 * template or `$derived`, since it reads the project's settings.
 */
export function activeVaultColor(): string {
  return safeVaultColor(vaultStore.project?.settings.general?.vaultColor);
}
