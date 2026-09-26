/**
 * vaultLeaveGuard — what happens to unsaved work when the user closes the
 * vault or opens another one.
 *
 * Filo saves as you go, so there is nothing to "not save" on purpose. Leaving
 * freezes the editors, hands over what components hold (an uncommitted title,
 * a debounced filter or camera move), saves, and asks only when something is
 * still not on disk afterwards. The views unmount later, in the swap, so this
 * is the last point where their changes can still be saved. That dialog names each file and
 * why; "Close anyway" / "Open anyway" first keeps a rescue copy of each in
 * `.filo/recovery/`, and asks once more for anything it couldn't copy.
 */
import { uiStore } from './ui.svelte';
import { describeUnsaved, keepRescueCopies } from './unsavedRescue';
import { isUnsavedWorkEmpty, unsavedWork } from '../lib/boards/writeStateTracking';
import { leaveVaultDialog, rescueFailedDialog, rescueKeptText, type RescueResult } from '../lib/vault/unsavedMessages';
import { reportError } from '../lib/utils/errorBus';
import { flushAllComponents, releaseFocusedField } from '../lib/boards/componentFlush';
import { holdCloseDrainUntilSwap } from '../lib/editor/closeDrainGate.svelte';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';

/**
 * - `saved`: nothing was left unsaved; the vault can be let go cleanly.
 * - `rescued`: the user chose to leave with unsaved work; copies were kept
 *   (the dirty sentinel stays, so reopening the vault offers recovery).
 * - `cancelled`: stay on this vault.
 */
export type LeaveOutcome = 'saved' | 'rescued' | 'cancelled';

/** A two-button native dialog; true when the first (go ahead) button was chosen. */
async function goAhead(title: string, message: string, detail: string, anyway: string): Promise<boolean> {
  try {
    const choice = await window.filo.invoke('dialog:choice', message, [anyway, 'Cancel'], {
      title,
      detail,
      defaultId: 1,
      cancelId: 1,
    });
    return choice === 0;
  } catch {
    // The dialog itself failed: stay, so nothing is dropped unseen.
    return false;
  }
}

async function saveOnce(save: () => Promise<boolean>): Promise<void> {
  try {
    await save();
  } catch (err) {
    reportError('vault.leave', err, 'Saving before leaving the vault failed');
  }
}

export async function saveBeforeLeaving(save: () => Promise<boolean>, kind: 'close' | 'open'): Promise<LeaveOutcome> {
  // The editors stay frozen from here until the swap has unmounted them, so
  // no keystroke lands after the check below; staying thaws them.
  const release = holdCloseDrainUntilSwap();
  try {
    releaseFocusedField();
    await saveOnce(save);
    // Something handed over while the save ran (a view the freeze doesn't
    // cover) gets one more save before anything is called unsaved.
    await flushAllComponents();
    if (!isUnsavedWorkEmpty(unsavedWork())) await saveOnce(save);
    const work = unsavedWork();
    if (isUnsavedWorkEmpty(work)) return 'saved';

    const items = await describeUnsaved(work);
    const dialog = leaveVaultDialog(items, kind);
    if (!(await goAhead(dialog.title, dialog.message, dialog.detail, dialog.anyway))) {
      release();
      return 'cancelled';
    }

    const rescue = await keepRescueCopies(unsavedWork());
    if (rescue.notKept.length > 0) {
      const again = rescueFailedDialog(rescue.notKept, dialog.anyway);
      if (!(await goAhead(dialog.title, again.message, again.detail, again.anyway))) {
        release();
        return 'cancelled';
      }
    }
    postRescueNotice(rescue);
    return 'rescued';
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Posted to outlive the swap: it says where the copies of the vault just left
 * went, and the Home screen or the next vault is what shows next.
 */
function postRescueNotice(rescue: RescueResult): void {
  const kept = rescueKeptText(rescue);
  const vaultRoot = getActiveVaultPath();
  if (!kept) return;
  const dir = rescue.dir && vaultRoot ? `${vaultRoot.replace(/[\\/]+$/, '')}/${rescue.dir}` : null;
  uiStore.pushToast({
    text: kept,
    type: 'info',
    duration: 0,
    sticky: true,
    survivesSwap: true,
    actions: dir ? [{ label: 'Show in folder', handler: () => void window.filo.invoke('shell:show-item-in-folder', dir) }] : [],
  });
}
