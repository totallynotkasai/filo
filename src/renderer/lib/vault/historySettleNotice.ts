import { uiStore } from '../../stores/ui.svelte';

/** How long a save waits quietly for a running undo or change before saying so. */
export const HISTORY_WAIT_NOTICE_MS = 2000;

const NOTICE_KEY = 'history-settle-wait';

/**
 * Awaits `settled` (the command chain: an undo, redo or change still running)
 * and, when that takes longer than a moment, says what the save is waiting
 * for. Save runs before close and quit, and a quit behind a slow undo would
 * otherwise look stuck, which invites killing Filo before the undo lands.
 */
export async function awaitHistoryWithNotice(settled: Promise<void>): Promise<void> {
  let shown = false;
  const timer = setTimeout(() => {
    shown = true;
    uiStore.pushToast({
      text: 'Finishing the last undo or change before saving…',
      type: 'info',
      duration: 0,
      sticky: true,
      dedupeKey: NOTICE_KEY,
    });
  }, HISTORY_WAIT_NOTICE_MS);
  try {
    await settled;
  } finally {
    clearTimeout(timer);
    if (shown) uiStore.dismissToastsByKey(NOTICE_KEY, { silent: true });
  }
}
