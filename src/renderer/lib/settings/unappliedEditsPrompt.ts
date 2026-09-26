/**
 * Asks what to do with a Settings tab's unapplied edits before an action
 * that would make them stale: a bulk "Apply … to all Boards" rewrites the
 * current board, and a theme pick resets the default colours. Re-arming the
 * tab's copy afterwards without asking would drop the edits silently; not
 * re-arming would let a later Apply write the old values back.
 */
import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
import { uiStore } from '../../stores/ui.svelte';

type Scope = 'global' | 'board';

const TAB_NAME: Record<Scope, string> = {
  global: 'Global Defaults',
  board: 'Current Board',
};

function hasEdits(scope: Scope): boolean {
  return scope === 'global'
    ? pendingSettingsStore.hasGlobalChanges()
    : pendingSettingsStore.hasBoardChanges();
}

/**
 * Resolves `true` when the action may go ahead: the tab had no edits, or
 * the user chose to apply them (and they applied) or to discard them.
 * Resolves `false` on Cancel, or when applying was refused (with a toast).
 */
export function settleUnappliedEdits(scope: Scope, action: string): Promise<boolean> {
  if (!hasEdits(scope)) return Promise.resolve(true);
  const tab = TAB_NAME[scope];
  return new Promise<boolean>((resolve) => {
    uiStore.openConfirm({
      title: `${tab} has unapplied changes`,
      body: `Apply or discard your ${tab} changes before you ${action}.`,
      confirmLabel: 'Apply them',
      cancelLabel: 'Cancel',
      secondaryAction: {
        label: 'Discard them',
        onClick: () => {
          if (scope === 'global') pendingSettingsStore.cancelGlobal();
          else pendingSettingsStore.cancelBoard();
          resolve(true);
        },
      },
      onConfirm: () => {
        const result = scope === 'global'
          ? pendingSettingsStore.applyGlobal()
          : pendingSettingsStore.applyBoard();
        if (!result.ok) {
          uiStore.toast(result.message, 'error');
          resolve(false);
          return;
        }
        resolve(true);
      },
      onCancel: () => resolve(false),
    });
  });
}
