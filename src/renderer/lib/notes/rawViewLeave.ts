/**
 * Switching a pane to another tab, or closing the pane, unmounts the
 * Document tab it showed, and with it any raw view open there. Text typed in
 * that raw view which can't be saved (the note changed somewhere else, or the
 * write failed) would then go only to a rescue copy, and its in-place "Keep
 * mine" would be gone. So both ask first, as closing the tab does.
 */
import { vaultPath } from '@shared/vaultPath';
import { dirtyRawViews, flushRawViews } from './rawViews';
import { uiStore } from '../../stores/ui.svelte';

/** True while a raw view of `notePath` holds text that isn't on disk. */
export function rawTextUnsaved(notePath: string | undefined): boolean {
  if (!notePath) return false;
  const key = vaultPath(notePath);
  return dirtyRawViews().some((view) => vaultPath(view.path()) === key);
}

/**
 * Saves the raw view of `notePath` and says whether the pane may leave it (by
 * switching its tab, or by closing): true once its text is on disk, or when
 * the user chose to go anyway (its unmount then keeps a copy in
 * `.filo/recovery/`); false to stay.
 */
export async function mayLeaveRawView(notePath: string, leaving: 'switch' | 'close' = 'switch'): Promise<boolean> {
  const { notSaved } = await flushRawViews([notePath]);
  if (notSaved.length === 0) return true;
  const names = notSaved.map((p) => `"${p}"`).join(', ');
  const go = leaving === 'switch' ? 'Switch anyway' : 'Close pane anyway';
  const stay = leaving === 'switch' ? 'Cancel stays on the tab' : 'Cancel keeps the pane open';
  return uiStore.confirmAsync({
    title: 'Raw edits not saved',
    body:
      `Your raw edits to ${names} aren't saved: the note changed somewhere else, or the write failed. ` +
      `${go} keeps a copy of them in .filo/recovery/. ${stay} so you can choose which version to keep.`,
    confirmLabel: go,
    cancelLabel: 'Cancel',
    danger: true,
  });
}
