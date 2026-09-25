import { setNoteCreatedListener } from './notes.svelte';
import { vaultStore } from './vault.svelte';

/**
 * Re-reads the sidebar tree after Filo creates a note (card, task, text tile,
 * dropped file, recreated note), since the watcher never reports our own
 * creates. Creates in a burst (several quick-added tasks) share one re-read,
 * plus one more if another create lands while it runs.
 */
let running = false;
let again = false;

async function refreshUntilSettled(): Promise<void> {
  running = true;
  try {
    do {
      again = false;
      await vaultStore.refreshTree();
    } while (again);
  } finally {
    running = false;
  }
}

function refreshSoon(): void {
  if (running) {
    again = true;
    return;
  }
  void refreshUntilSettled();
}

/** Installs the listener. Called once at startup (App.svelte). */
export function registerNewNotesInTree(): void {
  setNoteCreatedListener(refreshSoon);
}
