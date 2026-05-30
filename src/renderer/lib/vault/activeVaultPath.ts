/**
 * Active vault path — the vault root the renderer is currently committed to.
 *
 * A plain leaf holder so stores can reject stale cross-vault operations WITHOUT
 * importing the heavy `vaultStore`. A direct `document.svelte.ts → vault.svelte.ts`
 * import would close the cycle
 *   document.svelte.ts → vault.svelte.ts → vaultExternalChanges → document.svelte.ts
 * which reorders module init and breaks the cycle-sensitive `queueMicrotask`
 * prompt-handler wiring in vaultExternalChanges (the `setExternalEditPromptHandler`
 * injection). This module imports nothing, so reading it never forms a cycle.
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
