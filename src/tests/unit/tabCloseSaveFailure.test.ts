/**
 * `tabStore.close` / `closeOthers` must NOT silently destroy an editor when
 * its flush failed. Closing a tab whose backing IPC is rejecting (disk full,
 * permission revoked, antivirus quarantine) would otherwise drop the user's
 * last edits with zero UI feedback.
 *
 * When a note or board the closing tab shows still has unsaved changes after
 * the drain, tabStore says so ("Unsaved changes") before closing. Closing
 * loses nothing (the change stays in memory and is retried, and quit or close
 * vault ask again), and the dialog says exactly that. Cancel keeps the tab
 * open. A failure that belongs to a note another open tab shows is reported
 * with a toast and doesn't gate this close.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/boardSaver';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Polls until `uiStore.confirmDialog` becomes non-null or the timeout
 * expires. `tabStore.close` opens the dialog after several sequential
 * awaits (the note drain's read, write and board flush) and the exact
 * microtask count isn't stable.
 */
async function waitForConfirmDialog(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (uiStore.confirmDialog) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('confirm dialog did not open within 50 ticks');
}

const NOTE = '---\ntitle: Note\n---\nBody\n';

describe('tabStore.close — confirm on save failure', () => {
  let vault: MemoryVault;

  /** Queues a frontmatter change on `rel` whose write will fail once. */
  function failingEdit(rel: string): void {
    vault.failNextWrite(rel, 'ENOSPC');
    noteStore.patchFrontmatter(rel, { set: { status: 'edited' }, unset: [] });
  }

  beforeEach(() => {
    restoreFiloDefault();
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({ 'Note.md': NOTE, 'Other.md': NOTE });
    tabStore.closeAll();
    uiStore.closeConfirm();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    tabStore.closeAll();
    uiStore.closeConfirm();
    vi.restoreAllMocks();
  });

  it('opens a confirm dialog when the write of a note the tab shows fails', async () => {
    const tab = tabStore.openNote('Note.md', 'Note');
    failingEdit('Note.md');
    const closePromise = tabStore.close(tab.id);

    await waitForConfirmDialog();

    expect(uiStore.confirmDialog).not.toBeNull();
    expect(uiStore.confirmDialog?.title).toBe('Unsaved changes');
    expect(uiStore.confirmDialog?.body).toBe(
      '"Note.md" still has unsaved changes. Filo will keep trying, and will ask again when you quit or close the vault.',
    );
    expect(uiStore.confirmDialog?.confirmLabel).toBe('Close tab');
    // Nothing is thrown away, so it isn't styled as destructive.
    expect(uiStore.confirmDialog?.danger).not.toBe(true);

    // Cancel — tab stays open, edits preserved.
    uiStore.confirmDialog?.onCancel?.();
    uiStore.closeConfirm();
    await closePromise;

    expect(tabStore.tabs.some((t) => t.id === tab.id)).toBe(true);
    expect(noteStore.hasPendingWrites('Note.md')).toBe(true);
  });

  it('completes the close when the user picks "Close anyway"', async () => {
    const tab = tabStore.open('board-1', 'Board One', 'mindmap', '');
    // A failure no open tab can claim still gates the close.
    failingEdit('Note.md');
    const closePromise = tabStore.close(tab.id);

    await waitForConfirmDialog();

    expect(uiStore.confirmDialog).not.toBeNull();

    // Confirm — tab gets closed despite the failure (user opted in).
    uiStore.confirmDialog?.onConfirm?.(false);
    uiStore.closeConfirm();
    await closePromise;

    expect(tabStore.tabs.some((t) => t.id === tab.id)).toBe(false);
  });

  it('does NOT open the confirm when all flushes succeed', async () => {
    const tab = tabStore.openNote('Note.md', 'Note');
    noteStore.patchFrontmatter('Note.md', { set: { status: 'edited' }, unset: [] });
    await tabStore.close(tab.id);

    expect(uiStore.confirmDialog).toBeNull();
    expect(tabStore.tabs.length).toBe(0);
    expect(vault.read('Note.md')).toContain('status: edited');
  });

  it('a failure in a note another tab shows is a toast, not a confirm on this close', async () => {
    const toast = vi.spyOn(uiStore, 'toast');
    const closing = tabStore.openNote('Note.md', 'Note');
    const other = tabStore.openNote('Other.md', 'Other');
    failingEdit('Other.md');

    await tabStore.close(closing.id);

    expect(uiStore.confirmDialog).toBeNull();
    expect(tabStore.tabs.map((t) => t.id)).toEqual([other.id]);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('other tabs'), 'warning', 6000);
  });

  it('closeOthers also surfaces a confirm when any flush rejects', async () => {
    const t1 = tabStore.open('board-a', 'A', 'mindmap', '');
    const t2 = tabStore.openNote('Note.md', 'Note');
    expect(tabStore.tabs.length).toBe(2);
    failingEdit('Note.md');

    const closePromise = tabStore.closeOthers(t1.id);

    await waitForConfirmDialog();

    expect(uiStore.confirmDialog).not.toBeNull();
    expect(uiStore.confirmDialog?.title).toBe('Unsaved changes');

    // Cancel — both tabs still present.
    uiStore.confirmDialog?.onCancel?.();
    uiStore.closeConfirm();
    await closePromise;

    expect(tabStore.tabs.length).toBe(2);
    expect(tabStore.tabs.some((t) => t.id === t1.id)).toBe(true);
    expect(tabStore.tabs.some((t) => t.id === t2.id)).toBe(true);
  });
});
