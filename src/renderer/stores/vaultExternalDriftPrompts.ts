/**
 * Vault slice — the board drift prompt, and startup registration of the
 * prompts the writers ask.
 *
 * `promptBoardExternalEdit` is the Promise-based Reload / Keep-local prompt
 * the board writer awaits when an external edit lands in its read->write gap,
 * deduped per path through `inFlightDriftPrompts` (vault-swap reset and
 * rename-transfer wired). Notes don't need a Promise-based prompt: the note
 * writer keeps a conflicting body queued and the note store asks once
 * (`notePrompts.ts`).
 */
import { uiStore } from './ui.svelte';
import { setBoardExternalEditHandler } from '../lib/boards/boardWriteScheduler';
import { registerPathRenamable } from '../lib/vault/renamePathKeys';
import { vaultSwapResettable } from '../core/vaultLifecycle';
import { registerNotePrompts } from './notePrompts';

/**
 * In-flight prompt registry. While a Reload / Keep-local toast is open for
 * `path`, every concurrent caller awaits the SAME Promise so a save storm
 * doesn't stack duplicate toasts. Cleared when the promise settles, so a later
 * external edit + write race opens a fresh prompt.
 *
 * Reset on vault swap so a stale unresolved entry can't block a fresh prompt
 * for the same path in the new vault.
 */
const inFlightDriftPrompts = new Map<string, Promise<'reload' | 'keep-local' | 'defer'>>();
vaultSwapResettable('vaultExternalChanges.inFlightDriftPrompts', () => inFlightDriftPrompts.clear());
// On rename, move an in-flight prompt to the new key so it isn't stranded under
// the old one and a post-rename save doesn't open a duplicate prompt.
registerPathRenamable('vaultExternalChanges.inFlightDriftPrompts', (oldRel, newRel) => {
  const inflight = inFlightDriftPrompts.get(oldRel);
  if (inflight === undefined) return;
  inFlightDriftPrompts.delete(oldRel);
  inFlightDriftPrompts.set(newRel, inflight);
});

/**
 * Reload / Keep-local prompt for board JSON drift. Resolves to:
 *   - 'reload' — user wants Filo to discard the in-memory cache and let
 *                disk win. The caller is responsible for any reload
 *                bookkeeping; the toast just resolves and returns.
 *   - 'keep-local' — user wants their in-memory edits to overwrite the
 *                    external change. The caller proceeds with the write.
 *   - 'defer' — user dismissed the prompt without choosing.
 *                Caller MUST abort the write so the external edit on
 *                disk survives; the dirty board cache is left intact so
 *                the next debounced write re-prompts.
 *
 * Promise-backed toast: 15s cap (never sticky); a timeout or dismiss resolves
 * 'defer' so the paused write aborts instead of stranding.
 */
export function promptBoardExternalEdit(args: {
  path: string;
}): Promise<'reload' | 'keep-local' | 'defer'> {
  const { path } = args;
  // A save storm produces ONE toast + ONE decision.
  const existing = inFlightDriftPrompts.get(path);
  if (existing) return existing;

  const promise = new Promise<'reload' | 'keep-local' | 'defer'>((resolve) => {
    uiStore.pushToast({
      text: `"${path}" was modified externally between Filo's load and the next save. Reload from disk (discard in-memory changes), or keep your local edits? (Dismiss to defer — no changes saved.)`,
      type: 'warning',
      duration: 0,
      // Dismiss resolves to 'defer' so the writer aborts
      // without touching disk OR cache. The dirty board cache survives,
      // so the next debounced write re-prompts and the user must
      // explicitly choose to overwrite.
      onDismiss: () => resolve('defer'),
      actions: [
        {
          label: 'Reload',
          handler: () => {
            // Caller decides how to surface the reload. We just signal
            // the choice; the writer treats it as "abort this write".
            resolve('reload');
          },
        },
        {
          label: 'Keep local',
          // allow-keep-local-no-backup: resolves 'keep-local' to the board writer, which backs up (boardWriteScheduler)
          handler: () => {
            uiStore.pushToast({
              text: `External edit to "${path}" will be overwritten on the next save.`,
              type: 'info',
              duration: 4000,
            });
            resolve('keep-local');
          },
        },
      ],
    });
  });

  inFlightDriftPrompts.set(path, promise);
  // Drop the entry when the prompt settles so a future board-drift race opens
  // a fresh prompt; guard against an unrelated re-register replacing our slot.
  void promise.finally(() => {
    if (inFlightDriftPrompts.get(path) === promise) {
      inFlightDriftPrompts.delete(path);
    }
  });
  return promise;
}

/**
 * Installs the prompts the writers ask. `lib/` writers can't import
 * `stores/`, so they expose setters. App.svelte calls this at startup: by
 * then every module has finished evaluating, so the setters are always live.
 * Registering at module load instead would depend on evaluation order through
 * the store import cycles, and a cycle could leave a writer with no prompt.
 */
export function registerDriftPromptHandlers(): void {
  setBoardExternalEditHandler((path) => promptBoardExternalEdit({ path }));
  registerNotePrompts();
}

/** Test-only: a view of the in-flight prompt registry. */
export function __inFlightDriftPromptsForTests(): {
  size: number;
  has: (path: string) => boolean;
} {
  return {
    size: inFlightDriftPrompts.size,
    has: (path: string) => inFlightDriftPrompts.has(path),
  };
}
