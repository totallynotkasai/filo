/**
 * Active vault path — the vault root the renderer is currently committed to.
 *
 * A plain leaf holder so stores can reject stale cross-vault operations WITHOUT
 * importing the heavy `vaultStore`: `vault.svelte.ts` imports most stores
 * (through `vaultExternalChanges` among others), so a store importing it back
 * would close a cycle and reorder module init. This module imports nothing,
 * so reading it never forms a cycle.
 *
 * Published at vault commit by `seedViewportsCache` (the single commit-time call
 * that receives the candidate vault path) and cleared on swap/close by
 * `clearViewportsCache`. Reads therefore always reflect the COMMITTED vault: a
 * consumer comparing against it sees the OUTGOING vault during the swap window
 * (pre-swap → commit) and the INCOMING vault only once the open has committed.
 */
let activeVaultPath = '';

export function getActiveVaultPath(): string {
  return activeVaultPath;
}

export function setActiveVaultPath(path: string): void {
  activeVaultPath = path;
}
