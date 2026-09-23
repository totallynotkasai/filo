import { describe, it, expect, vi, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { UpdatePropertiesCommand, type PropertiesSnapshot } from '@renderer/commands/index';

/**
 * Audit-12 M3 — PropertiesPopup must push its undo command onto the board it
 * was opened on, not whichever board is active when it closes.
 *
 * The popup builds its `UpdatePropertiesCommand` in onDestroy. The command's
 * constructor falls back to `boardStore.current?.id` (the GLOBALLY-active board)
 * when no explicit boardId is passed. In split-pane, opening Properties on pane
 * B then clicking pane A before closing made the command target pane A — pushing
 * a non-text tile's edit onto the wrong stack (or no-op'ing the metadata
 * applySnapshot). The fix captures the pane-scoped board id at MOUNT and passes
 * it; the component wiring is pinned by `ci:command-targets-self`.
 *
 * The popup itself isn't mountable in jsdom, so these lock the command-level
 * guarantee the fix relies on: an explicit mount-time id always wins over the
 * destroy-time global active board, and execute/undo dirty THAT board.
 *
 * `boardStore` is the global facade Proxy; its `set` trap installs a property
 * override (the same hook `vi.spyOn` uses for methods), so assigning
 * `boardStore.current` simulates "the global active board is pane A".
 */
type CurrentOverride = { current?: { id: string } };

describe('Audit-12 M3 — UpdatePropertiesCommand targets the captured board', () => {
  const before: PropertiesSnapshot = { kind: 'metadata', tileId: 't1', metadata: { status: 'todo' } };
  const after: PropertiesSnapshot = { kind: 'metadata', tileId: 't1', metadata: { status: 'done' } };

  function setGlobalActiveBoard(id: string): void {
    (boardStore as unknown as CurrentOverride).current = { id };
  }

  afterEach(() => {
    delete (boardStore as unknown as CurrentOverride).current;
    vi.restoreAllMocks();
  });

  it('uses the explicit mount-captured id, not the destroy-time active board', () => {
    // Simulate: pane B opened the popup; by close time the global active board
    // pivoted to pane A.
    setGlobalActiveBoard('pane-A-board');

    const cmd = new UpdatePropertiesCommand(before, after, 'pane-B-board');
    expect(cmd.targetBoardId).toBe('pane-B-board');
  });

  it('without an explicit id, falls back to the global active board (the pre-M3 hazard)', () => {
    setGlobalActiveBoard('pane-A-board');

    const cmd = new UpdatePropertiesCommand(before, after);
    expect(cmd.targetBoardId).toBe('pane-A-board');
  });

  it('execute dirties the captured board (so undo lands on the popup pane)', async () => {
    setGlobalActiveBoard('pane-A-board');
    vi.spyOn(boardStore, 'updateTile').mockImplementation(() => {});
    const markDirty = vi.spyOn(boardCacheStore, 'markDirty').mockImplementation(() => {});

    const cmd = new UpdatePropertiesCommand(before, after, 'pane-B-board');
    await cmd.execute();
    expect(markDirty).toHaveBeenCalledWith('pane-B-board');
    expect(markDirty).not.toHaveBeenCalledWith('pane-A-board');

    markDirty.mockClear();
    await cmd.undo();
    expect(markDirty).toHaveBeenCalledWith('pane-B-board');
  });
});
