import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tabStore } from '@renderer/stores/tabs.svelte';
import {
  __testRegisterFlusher as registerMarkdownFlusher,
  __resetMarkdownFileWriterForTests as __resetMarkdownFlushersForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/boardSaver';

/**
 * Sprint B / B2: `tabStore.close` must drain pending markdown / frontmatter
 * writers BEFORE removing the tab from `tabs`. Removing the tab triggers the
 * Svelte unmount of any TextTile / DocumentEditor inside it, which fires its
 * onDestroy flush as fire-and-forget — so without an awaited drain in
 * `close`, the last 300 ms of debounced edits race the contextBridge IPC
 * teardown and can silently disappear.
 *
 * The verification approach: register a deliberately-slow flusher that
 * records when it completes, then call `close` and observe whether the flush
 * resolved BEFORE the tab was removed from `tabStore.tabs`.
 */

function installFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

describe('tabStore.close — Sprint B / B2 flush before unmount', () => {
  beforeEach(() => {
    uninstallFiloStub();
    installFiloStub();
    __resetMarkdownFlushersForTests();
    __resetDirtyTrackingForTests();
    tabStore.closeAll();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    uninstallFiloStub();
    __resetMarkdownFlushersForTests();
    __resetDirtyTrackingForTests();
    tabStore.closeAll();
  });

  it('awaits every registered markdown flusher before mutating the tabs array', async () => {
    const events: string[] = [];
    let resolveFlush: (() => void) | null = null;
    const flushPromise = new Promise<void>((res) => {
      resolveFlush = res;
    });
    registerMarkdownFlusher('text-tile:t1', async () => {
      await flushPromise;
      events.push('flush-done');
    });

    const tab = tabStore.open('board-1', 'Board One', 'mindmap', '');
    expect(tabStore.tabs.some((t) => t.id === tab.id)).toBe(true);

    const closePromise = tabStore.close(tab.id);

    // Microtask boundary — the close is awaiting the flusher and has NOT
    // mutated tabs yet. (If the implementation had been fire-and-forget,
    // tabs would already be empty here.)
    await Promise.resolve();
    expect(tabStore.tabs.some((t) => t.id === tab.id)).toBe(true);

    // Release the flusher. After this resolves, close can proceed and
    // remove the tab.
    resolveFlush?.();
    await closePromise;

    // Audit-16 6.7 — close() runs the flush pass TWICE (the second pass
    // captures keystrokes that re-armed a debounce during the first drain /
    // interactive confirm), so the flusher fires once per pass.
    expect(events).toEqual(['flush-done', 'flush-done']);
    expect(tabStore.tabs.some((t) => t.id === tab.id)).toBe(false);
  });

  it('proceeds normally when no flushers are registered (no-op flush)', async () => {
    const tab = tabStore.open('board-2', 'Board Two', 'kanban', '');
    expect(tabStore.tabs.length).toBe(1);
    await tabStore.close(tab.id);
    expect(tabStore.tabs.length).toBe(0);
  });

  it('closeOthers also drains pending writes before removing the other tabs', async () => {
    let flushCount = 0;
    registerMarkdownFlusher('text-tile:a', async () => {
      flushCount++;
    });
    registerMarkdownFlusher('text-tile:b', async () => {
      flushCount++;
    });

    const t1 = tabStore.open('board-a', 'A', 'mindmap', '');
    const t2 = tabStore.open('board-b', 'B', 'mindmap', '');
    const t3 = tabStore.open('board-c', 'C', 'mindmap', '');
    expect(tabStore.tabs.length).toBe(3);

    await tabStore.closeOthers(t2.id);

    // Audit-16 6.7 — two flushers × two flush passes (see close() test above).
    expect(flushCount).toBe(4);
    expect(tabStore.tabs.length).toBe(1);
    expect(tabStore.tabs[0].id).toBe(t2.id);
    // Suppress unused-variable lint for t1/t3 (their ids are the basis of
    // the "other" closures).
    expect(t1.id).not.toBe(t2.id);
    expect(t3.id).not.toBe(t2.id);
  });
});
