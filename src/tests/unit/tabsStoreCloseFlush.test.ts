import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/boardSaver';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * `tabStore.close` must drain pending note writes BEFORE removing the tab
 * from `tabs`. Removing the tab unmounts any TextTile / DocumentEditor
 * inside it, whose onDestroy flush is fire-and-forget — so without an
 * awaited drain in `close`, the last 300 ms of debounced edits race the
 * contextBridge IPC teardown and can silently disappear.
 *
 * The verification approach: hold a queued note write open, then call
 * `close` and observe that the write landed BEFORE the tab was removed from
 * `tabStore.tabs`.
 */

const NOTE = '---\ntitle: Note\n---\nBody\n';

describe('tabStore.close — flush before unmount', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    restoreFiloDefault();
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({ 'A.md': NOTE, 'B.md': NOTE });
    tabStore.closeAll();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    tabStore.closeAll();
  });

  it('awaits every queued note write before mutating the tabs array', async () => {
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((res) => {
      release = res;
    });
    let writeStarted = false;
    vault.beforeWrite = async (rel) => {
      if (!rel.endsWith('.md')) return;
      writeStarted = true;
      await held;
      events.push('write-done');
    };
    noteStore.patchFrontmatter('A.md', { set: { status: 'edited' }, unset: [] });

    const tab = tabStore.open('board-1', 'Board One', 'mindmap', '');
    expect(tabStore.tabs.some((t) => t.id === tab.id)).toBe(true);

    const closePromise = tabStore.close(tab.id);

    // The close is waiting on the held write and has NOT mutated tabs yet.
    // (A fire-and-forget implementation would already have emptied tabs.)
    for (let i = 0; i < 50 && !writeStarted; i++) await new Promise((r) => setTimeout(r, 0));
    expect(writeStarted).toBe(true);
    expect(tabStore.tabs.some((t) => t.id === tab.id)).toBe(true);

    release();
    await closePromise;

    expect(events).toEqual(['write-done']);
    expect(vault.read('A.md')).toContain('status: edited');
    expect(tabStore.tabs.some((t) => t.id === tab.id)).toBe(false);
  });

  it('proceeds normally when nothing is queued (no-op flush)', async () => {
    const tab = tabStore.open('board-2', 'Board Two', 'kanban', '');
    expect(tabStore.tabs.length).toBe(1);
    await tabStore.close(tab.id);
    expect(tabStore.tabs.length).toBe(0);
  });

  it('closeOthers also drains pending writes before removing the other tabs', async () => {
    const tabCountAtWrite: number[] = [];
    vault.beforeWrite = (rel) => {
      if (!rel.endsWith('.md')) return;
      tabCountAtWrite.push(tabStore.tabs.length);
    };
    noteStore.patchFrontmatter('A.md', { set: { status: 'a' }, unset: [] });
    noteStore.patchFrontmatter('B.md', { set: { status: 'b' }, unset: [] });

    const t1 = tabStore.open('board-a', 'A', 'mindmap', '');
    const t2 = tabStore.open('board-b', 'B', 'mindmap', '');
    const t3 = tabStore.open('board-c', 'C', 'mindmap', '');
    expect(tabStore.tabs.length).toBe(3);

    await tabStore.closeOthers(t2.id);

    // Both writes landed while all three tabs were still open.
    expect(tabCountAtWrite).toEqual([3, 3]);
    expect(vault.read('A.md')).toContain('status: a');
    expect(vault.read('B.md')).toContain('status: b');
    expect(tabStore.tabs.length).toBe(1);
    expect(tabStore.tabs[0].id).toBe(t2.id);
    expect(t1.id).not.toBe(t2.id);
    expect(t3.id).not.toBe(t2.id);
  });
});
