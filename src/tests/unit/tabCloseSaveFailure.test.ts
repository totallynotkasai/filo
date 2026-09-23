/**
 * Phase 4 / 4.2 — `tabStore.close` / `closeOthers` must NOT silently
 * destroy an editor when its flush failed. Closing a tab whose backing
 * IPC is rejecting (disk full, permission revoked, antivirus quarantine)
 * previously dropped the user's last edits with zero UI feedback.
 *
 * The fix: on non-empty `failed[]` from any of the three drain calls
 * (markdown / frontmatter / board), tabStore opens a confirm dialog
 * ("Save failed — close anyway?"). Confirm proceeds with the close
 * (data is lost but the user asked for it). Cancel keeps the tab open
 * so the user can retry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  __testRegisterFlusher as registerMarkdownFlusher,
  __resetMarkdownFileWriterForTests as __resetMarkdownFlushersForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/boardSaver';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Polls until `uiStore.confirmDialog` becomes non-null or the timeout
 * expires. Needed because `tabStore.close` opens the dialog after at
 * least three sequential awaits (flushAllMarkdownWriters,
 * flushAllPendingFrontmatterWrites, flushDirty) and the exact microtask
 * count isn't stable.
 */
async function waitForConfirmDialog(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (uiStore.confirmDialog) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('confirm dialog did not open within 50 ticks');
}

describe('tabStore.close — Phase 4 / 4.2 confirm on save failure', () => {
  beforeEach(() => {
    restoreFiloDefault();
    __resetMarkdownFlushersForTests();
    __resetDirtyTrackingForTests();
    tabStore.closeAll();
    uiStore.closeConfirm();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    restoreFiloDefault();
    __resetMarkdownFlushersForTests();
    __resetDirtyTrackingForTests();
    tabStore.closeAll();
    uiStore.closeConfirm();
  });

  it('opens a confirm dialog when a registered markdown flusher rejects', async () => {
    registerMarkdownFlusher('text-tile:t1', async () => {
      throw new Error('disk full');
    });

    const tab = tabStore.open('board-1', 'Board One', 'mindmap', '');
    const closePromise = tabStore.close(tab.id);

    await waitForConfirmDialog();

    expect(uiStore.confirmDialog).not.toBeNull();
    expect(uiStore.confirmDialog?.title).toBe('Save failed');

    // Cancel — tab stays open, edits preserved.
    uiStore.confirmDialog?.onCancel?.();
    uiStore.closeConfirm();
    await closePromise;

    expect(tabStore.tabs.some((t) => t.id === tab.id)).toBe(true);
  });

  it('completes the close when the user picks "Close anyway"', async () => {
    registerMarkdownFlusher('text-tile:t1', async () => {
      throw new Error('disk full');
    });

    const tab = tabStore.open('board-1', 'Board One', 'mindmap', '');
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
    registerMarkdownFlusher('text-tile:t1', async () => {});
    const tab = tabStore.open('board-1', 'Board One', 'mindmap', '');
    await tabStore.close(tab.id);

    expect(uiStore.confirmDialog).toBeNull();
    expect(tabStore.tabs.length).toBe(0);
  });

  it('closeOthers also surfaces a confirm when any flush rejects', async () => {
    registerMarkdownFlusher('text-tile:fail', async () => {
      throw new Error('EACCES');
    });

    const t1 = tabStore.open('board-a', 'A', 'mindmap', '');
    const t2 = tabStore.open('board-b', 'B', 'mindmap', '');
    expect(tabStore.tabs.length).toBe(2);

    const closePromise = tabStore.closeOthers(t1.id);

    await waitForConfirmDialog();

    expect(uiStore.confirmDialog).not.toBeNull();
    expect(uiStore.confirmDialog?.title).toBe('Save failed');

    // Cancel — both tabs still present.
    uiStore.confirmDialog?.onCancel?.();
    uiStore.closeConfirm();
    await closePromise;

    expect(tabStore.tabs.length).toBe(2);
    expect(tabStore.tabs.some((t) => t.id === t1.id)).toBe(true);
    expect(tabStore.tabs.some((t) => t.id === t2.id)).toBe(true);
  });
});
