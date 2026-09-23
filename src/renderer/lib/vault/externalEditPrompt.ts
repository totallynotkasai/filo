/**
 * Phase R6 — listener slot for the Reload / Keep-local prompt the markdown
 * write gateway surfaces when a pre-write stat detects an external edit
 * landed inside the debounce window. The implementation lives in
 * `stores/vaultExternalDriftPrompts` (it depends on uiStore + documentStore +
 * boardStore which `lib/` doesn't import directly), and is registered at
 * module-load on the store side via `setExternalEditPromptHandler`.
 *
 * Returning `null` from the handler — or having no handler registered — is
 * treated as "Keep local"; the write proceeds. This matches the legacy
 * behaviour where the writer had no drift detection at all.
 *
 * 6.4.M4 — `'defer'` was added so the toast's auto-dismiss / manual-close
 * path no longer silently overwrites the external edit. The writer treats
 * `'defer'` like `'reload'` for the abort effect (no write fires), but the
 * handler must NOT have touched disk or editor — the in-memory dirty state
 * persists so the next debounced write re-prompts.
 *
 * Audit-16 (split from `markdownFileWriter.ts` for the file-size ceiling) —
 * a dependency-free LEAF on purpose: the gateway reads the slot, the store
 * registers into it, and neither pulls the other's import graph (see the
 * Audit-14 6.2 module-eval-cycle note on the registration site).
 */

export type ExternalEditPromptHandler = (
  path: string,
) => Promise<'reload' | 'keep-local' | 'defer'>;

let externalEditPromptHandler: ExternalEditPromptHandler | null = null;

export function setExternalEditPromptHandler(handler: ExternalEditPromptHandler | null): void {
  externalEditPromptHandler = handler;
}

export function getExternalEditPromptHandler(): ExternalEditPromptHandler | null {
  return externalEditPromptHandler;
}
