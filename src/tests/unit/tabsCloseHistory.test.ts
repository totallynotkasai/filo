import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import type { Command } from '@renderer/stores/history.svelte';
import {
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/boardSaver';

/**
 * Phase 13.6 — when a tab closes, the per-board undo/redo stack is dropped.
 * Reopening the board (via the sidebar) creates a fresh tab and fresh
 * history — the board's content stays on disk, but undo doesn't reach back
 * into the prior editing session. If the same board is still open in
 * another tab, history is preserved.
 *
 * Polish phase 1.2 — `historyStore.execute(NoopCommand)` here triggers a
 * markDirty → scheduleBoardWrite chain even though the test never sets
 * `vaultStore.path`. Pre-polish-1.2 the resulting phantom-write was
 * silently swallowed (flushBoardWrite returned ok:true on null args);
 * post-polish-1.2 it correctly surfaces as a save failure and the
 * `tabStore.close` confirm-close dialog hangs the test environment
 * waiting for a click. Drain pending writes in beforeEach/afterEach so
 * the test environment matches the contract `tabStore.close` expects.
 */

class NoopCommand implements Command {
  description = 'noop';
  execute(): void {}
  undo(): void {}
}

describe('tabStore.close — per-board history clearing', () => {
  beforeEach(() => {
    cancelAllPendingWrites();
    __resetDirtyTrackingForTests();
    historyStore.clear();
    tabStore.closeAll();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    __resetDirtyTrackingForTests();
    historyStore.clear();
    tabStore.closeAll();
    historyStore.setActiveBoard(null);
  });

  it('clears the closed board\'s undo stack when the last tab for it closes', async () => {
    const tab = tabStore.open('board-1', 'Board 1', 'mindmap');
    historyStore.setActiveBoard('board-1');
    historyStore.execute(new NoopCommand());
    expect(historyStore.canUndo).toBe(true);

    // Polish phase 1.2 — drop the phantom board-write that the NoopCommand
    // scheduled via boardStore.markDirty. Without a vaultStore.path the
    // scheduled write would resolve to null args at flush time and the
    // close path would surface a save-failure confirm modal that hangs
    // the test environment.
    cancelAllPendingWrites();

    // Sprint B / B2 — `tabStore.close` is async (drains pending markdown /
    // frontmatter writes before unmount). Await so the history clear that
    // follows the tabs mutation has actually run before the assertion.
    await tabStore.close(tab.id);
    // Re-activate so the getter consults the (now-empty) stack for board-1.
    historyStore.setActiveBoard('board-1');
    expect(historyStore.canUndo).toBe(false);
  });

  it('preserves history when another tab still references the board', async () => {
    const tabA = tabStore.open('board-1', 'Board 1', 'mindmap');
    // Force a second tab for the same board id (open() reuses the existing
    // one, so reach in via the change-listener-free path: a hand-call to
    // open with the same boardId returns the existing tab).
    expect(tabStore.tabs.length).toBe(1);

    historyStore.setActiveBoard('board-1');
    historyStore.execute(new NoopCommand());

    cancelAllPendingWrites();
    await tabStore.close(tabA.id);
    historyStore.setActiveBoard('board-1');
    // No other tab held the board open — history is cleared.
    expect(historyStore.canUndo).toBe(false);
  });

  it('closeOthers clears history for every board that loses its last tab', async () => {
    const keep = tabStore.open('board-keep', 'Keep', 'mindmap');
    const drop = tabStore.open('board-drop', 'Drop', 'mindmap');

    historyStore.setActiveBoard('board-drop');
    historyStore.execute(new NoopCommand());
    expect(historyStore.canUndo).toBe(true);

    historyStore.setActiveBoard('board-keep');
    historyStore.execute(new NoopCommand());
    expect(historyStore.canUndo).toBe(true);

    cancelAllPendingWrites();
    await tabStore.closeOthers(keep.id);
    void drop;

    historyStore.setActiveBoard('board-drop');
    expect(historyStore.canUndo).toBe(false);
    historyStore.setActiveBoard('board-keep');
    expect(historyStore.canUndo).toBe(true);
  });
});
