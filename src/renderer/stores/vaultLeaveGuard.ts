/**
 * vaultLeaveGuard — what happens to unsaved work when the user closes the
 * vault or opens another one.
 *
 * Filo saves as you go, so there is nothing to "not save" on purpose. Leaving
 * freezes the editors, hands over what components hold (an uncommitted title,
 * a debounced filter or camera move), saves, and asks only when something is
 * still not on disk afterwards. Settings edits not yet applied (the theme
 * editor, a Settings tab) are asked about first, since no writer holds them.
 * The views unmount later, in the swap, so this
 * is the last point where their changes can still be saved. That dialog names each file and
 * why; "Close anyway" / "Open anyway" first keeps a rescue copy of each in
 * `.filo/recovery/`, and asks once more for anything it couldn't copy.
 */
import { tick } from 'svelte';
import { uiStore } from './ui.svelte';
import { describeUnsaved, keepRescueCopies, unsavedPathsAsSpelled } from './unsavedRescue';
import { isUnsavedWorkEmpty, unsavedWork } from '../lib/boards/writeStateTracking';
import { leaveVaultDialog, rescueFailedDialog, rescueKeptText, type RescueResult } from '../lib/vault/unsavedMessages';
import { reportError } from '../lib/utils/errorBus';
import { flushAllComponents, releaseFocusedField } from '../lib/boards/componentFlush';
import { holdCloseDrainUntilSwap } from '../lib/editor/closeDrainGate.svelte';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';
import { settleRenameQueue } from './vaultRenameQueue';
import { onVaultSwap } from '../core/vaultLifecycle';
import { markDirty } from '../lib/vault/dirtyFlagRecovery';
import { rollbackRawRescues } from '../lib/notes/rawViews';

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

/**
 * Asks about unapplied Settings edits; true to go on. Loaded when needed: the
 * settings stores import the vault store, which imports this module. A
 * failure stays, so nothing is dropped unseen.
 */
async function settleSettingsFirst(kind: 'close' | 'open'): Promise<boolean> {
  try {
    const { settleOpenSettings } = await import('../lib/settings/settleOpenSettings');
    return await settleOpenSettings(kind);
  } catch (err) {
    reportError('vault.leave', err, 'Asking about unapplied settings before leaving the vault failed');
    return false;
  }
}

async function saveOnce(save: () => Promise<boolean>): Promise<boolean> {
  try {
    return await save();
  } catch (err) {
    reportError('vault.leave', err, 'Saving before leaving the vault failed');
    return false;
  }
}

/**
 * The save that leaving and quitting share: take focus off a text field (a
 * field that saves on blur hands its text over), save, let what views and the
 * watcher's queued reconciles handed over meanwhile reach the writers, and
 * save once more if anything is still unsaved. The caller freezes the editors
 * first and decides from `unsavedWork()` afterwards. True when the last save
 * reported no failure.
 */
export async function saveUntilSettled(save: () => Promise<boolean>): Promise<boolean> {
  releaseFocusedField();
  let ok = await saveOnce(save);
  // Something handed over while the save ran (a view the freeze doesn't
  // cover), or a reconcile that queued a write (a rebound board path, a tag
  // move), gets one more save before anything is called unsaved.
  await flushAllComponents();
  await settleRenameQueue();
  if (!isUnsavedWorkEmpty(unsavedWork())) ok = await saveOnce(save);
  return ok;
}

export async function saveBeforeLeaving(save: () => Promise<boolean>, kind: 'close' | 'open'): Promise<LeaveOutcome> {
  // Settings the user hasn't applied (a theme being edited, a Settings tab)
  // are in no writer, so the save below wouldn't see them: ask first.
  if (!(await settleSettingsFirst(kind))) return 'cancelled';
  // The editors stay frozen from here until the swap has unmounted them, so
  // no keystroke lands after the check below; staying thaws them.
  const release = holdCloseDrainUntilSwap();
  try {
    await saveUntilSettled(save);
    const work = unsavedWork();
    if (isUnsavedWorkEmpty(work)) return 'saved';

    const items = await describeUnsaved(work);
    const dialog = leaveVaultDialog(items, kind);
    if (!(await goAhead(dialog.title, dialog.message, dialog.detail, dialog.anyway))) {
      release();
      return 'cancelled';
    }

    const leftWork = unsavedWork();
    const leftPaths = unsavedPathsAsSpelled(leftWork);
    const rescue = await keepRescueCopies(leftWork);
    if (rescue.notKept.length > 0) {
      const again = rescueFailedDialog(rescue.notKept, dialog.anyway);
      if (!(await goAhead(dialog.title, again.message, again.detail, again.anyway))) {
        rollbackRawRescues();
        release();
        return 'cancelled';
      }
    }
    postRescueNotice(rescue);
    // Some of this work (a raw view's text) is in no writer's ledger, so the
    // swap's own sentinel update wouldn't name it: reopening the vault must
    // still offer recovery.
    const vaultRoot = getActiveVaultPath();
    if (vaultRoot) await markDirty(vaultRoot, leftPaths);
    return 'rescued';
  } catch (err) {
    rollbackRawRescues();
    release();
    throw err;
  }
}

/**
 * The last line behind the save before leaving. A change still unsaved when a
 * vault is let go as saved arrived after that save (a reconcile that queued a
 * write, a view's teardown). The swap is about to cancel the board, config and
 * misc writes and reset the note writer, so everything unsaved is copied to
 * `.filo/recovery/` first and the crash sentinel is set again: reopening the
 * vault offers it. Runs after the tabs reset (whose teardown can queue a
 * change) and before the schedulers are cancelled; with work left, the
 * tracking reset then keeps the sentinel instead of clearing it.
 */
onVaultSwap('pre-swap', 'leftBehind', async (event) => {
  if (!event.saveOutgoing || !event.previousVault) return;
  // Let the views the tabs reset unmounts run their teardown first.
  await tick();
  const work = unsavedWork();
  if (isUnsavedWorkEmpty(work)) return;
  const paths = unsavedPathsAsSpelled(work);
  console.error('[vaultLeaveGuard] changes were queued after the save before leaving:', paths);
  const rescue = await keepRescueCopies(work);
  if (rescue.notKept.length > 0) {
    reportError('vault.leftBehind', null, `Couldn't keep a copy of the unsaved changes to ${rescue.notKept.join(', ')}`);
  }
  postRescueNotice(rescue);
  await markDirty(event.previousVault, paths);
}, { runAfter: ['tabs'] });

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
