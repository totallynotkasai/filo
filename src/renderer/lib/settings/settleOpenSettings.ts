/**
 * Settings edits the user hasn't applied yet, asked about before the vault is
 * left or Filo quits.
 *
 * An open theme editor's colours and a Settings tab's unapplied fields live
 * only in memory: the save before leaving never sees them, because nothing
 * has handed them to a writer. Leaving asks first, with the same prompts the
 * Settings dialog uses (Save / Discard / Keep editing for the theme; Apply /
 * Discard / Cancel for each tab), so an Apply reaches the writers before the
 * save runs, and Cancel stays.
 */
import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
import { settleThemeEditor, themeEditorHasChanges } from '../themes/themeEditorGuard';
import { settleUnappliedEdits } from './unappliedEditsPrompt';

export type LeaveKind = 'close' | 'open' | 'quit';

const ACTION: Record<LeaveKind, string> = {
  close: 'close the vault',
  open: 'open another vault',
  quit: 'quit Filo',
};

/** Whether the theme editor or a Settings tab holds edits that aren't applied. */
export function hasOpenSettingsEdits(): boolean {
  return themeEditorHasChanges() || pendingSettingsStore.hasUnsavedChanges();
}

/**
 * Resolves true when leaving may go ahead: nothing was open, or every prompt
 * was answered Save / Apply (and it went through) or Discard. False stays.
 *
 * A tab that was settled is re-armed from the live values, as the dialog's
 * own actions do: the leave can still be called off afterwards (a later
 * "couldn't be saved" dialog), and the dialog, still open, needs a copy to
 * edit.
 */
export async function settleOpenSettings(kind: LeaveKind): Promise<boolean> {
  if (!(await settleThemeEditor())) return false;
  const global = pendingSettingsStore.hasGlobalChanges();
  if (!(await settleUnappliedEdits('global', ACTION[kind]))) return false;
  if (global) pendingSettingsStore.startGlobal();
  const board = pendingSettingsStore.hasBoardChanges();
  if (!(await settleUnappliedEdits('board', ACTION[kind]))) return false;
  if (board) pendingSettingsStore.startBoard();
  return true;
}
