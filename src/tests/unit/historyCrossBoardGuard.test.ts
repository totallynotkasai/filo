/**
 * Cross-board undo guard.
 *
 * Acceptance test for the mandatory-targetBoardId contract. Per-board
 * history stacks mean each board has its own (un)stack — so the
 * pathological case the guard exists for is:
 *
 *   1. The user is on board B.
 *   2. A still-mounted side-effect from board A (e.g. a style popup
 *      destroy effect captured at A-mount time) pushes a command whose
 *      `targetBoardId === 'board-A'` onto whichever stack is currently
 *      active — `board-B`'s.
 *   3. Ctrl+Z on board B WOULD now silently apply a board-A mutation
 *      against board B.
 *
 * The guard (`history.svelte.ts:353-360` for undo, :378-385 for redo)
 * surfaces a toast asking the user to switch back to the originating
 * board instead. The third test pins the board-agnostic escape hatch:
 * commands with an empty-string `targetBoardId` skip the guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { Command } from '@renderer/commands/Command';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';

class BoardScopedCommand extends Command {
  description = 'board-scoped-cmd';
  readonly targetBoardId: string;
  executeCount = 0;
  undoCount = 0;
  constructor(boardId: string) {
    super();
    this.targetBoardId = boardId;
  }
  execute(): void {
    this.executeCount += 1;
  }
  undo(): void {
    this.undoCount += 1;
  }
}

class BoardAgnosticCommand extends Command {
  description = 'board-agnostic-cmd';
  readonly targetBoardId: string;
  executeCount = 0;
  undoCount = 0;
  constructor() {
    super();
    this.targetBoardId = '';
  }
  execute(): void {
    this.executeCount += 1;
  }
  undo(): void {
    this.undoCount += 1;
  }
}

/**
 * Test-only Command whose `targetBoardId` is mutable via `retarget()`.
 * Lets us seed a board-A-targeted command onto board B's redo stack via
 * the normal execute→undo dance (which only works when target matches
 * the active board), then re-point the target so the next redo trips
 * the guard.
 */
class RetargettableCommand extends Command {
  description = 'retargettable';
  executeCount = 0;
  undoCount = 0;
  private _target: string;
  constructor(initialTarget: string) {
    super();
    this._target = initialTarget;
  }
  get targetBoardId(): string {
    return this._target;
  }
  retarget(next: string): void {
    this._target = next;
  }
  execute(): void { this.executeCount += 1; }
  undo(): void { this.undoCount += 1; }
}

describe('historyStore — cross-board guard', () => {
  let toastSpy: MockInstance<typeof uiStore.toast>;

  beforeEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(500);
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    toastSpy.mockRestore();
  });

  it('undo refuses when the head command targets a different board and surfaces the switch-back toast', async () => {
    historyStore.setActiveBoard('board-B');

    // A latent push from a board-A side-effect lands a board-A-targeted
    // command on whatever stack is currently active — board B's.
    const cmd = new BoardScopedCommand('board-A');
    historyStore.pushWithoutExecute(cmd);
    expect(historyStore.canUndo).toBe(true);
    expect(cmd.undoCount).toBe(0);

    // Ctrl+Z on board B should refuse and surface the switch-back toast.
    await historyStore.undo();

    expect(cmd.undoCount).toBe(0);
    const switchToasts = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string'
      && args[0].includes('Switch to the originating board'),
    );
    expect(switchToasts.length).toBe(1);

    // The command is still on the stack — the guard refuses to pop it.
    expect(historyStore.canUndo).toBe(true);
  });

  it('redo refuses when the head command targets a different board and surfaces the switch-back toast', async () => {
    // Seed a command onto board B's redo stack by executing+undoing
    // while target matches B, then re-pointing to A so the next redo
    // trips the guard.
    historyStore.setActiveBoard('board-B');
    const cmd = new RetargettableCommand('board-B');
    await historyStore.execute(cmd);
    expect(cmd.executeCount).toBe(1);
    await historyStore.undo();
    expect(cmd.undoCount).toBe(1);
    expect(historyStore.canRedo).toBe(true);

    // Re-point the target. The next redo should refuse because the
    // active board (B) no longer matches.
    cmd.retarget('board-A');
    await historyStore.redo();

    expect(cmd.executeCount).toBe(1);
    const switchToasts = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string'
      && args[0].includes('Switch to the originating board'),
    );
    expect(switchToasts.length).toBe(1);
  });

  it('a command with empty targetBoardId is treated as board-agnostic — undo runs regardless of active board', async () => {
    // ReplaceAllCommand / CascadeDeleteCommand semantics: vault-wide or
    // board-spanning, no single owning board. The truthy guard in
    // history.svelte.ts skips the match check when targetBoardId is ''.
    historyStore.setActiveBoard('board-B');
    const cmd = new BoardAgnosticCommand();
    historyStore.pushWithoutExecute(cmd);
    expect(historyStore.canUndo).toBe(true);

    await historyStore.undo();
    expect(cmd.undoCount).toBe(1);

    const switchToasts = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string'
      && args[0].includes('Switch to the originating board'),
    );
    expect(switchToasts.length).toBe(0);
  });
});
