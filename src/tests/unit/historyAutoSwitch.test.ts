/**
 * History auto-switch to a command's originating board.
 *
 * Per-board undo stacks mean a command can land on the active board's stack
 * while targeting a DIFFERENT board (e.g. a still-mounted side-effect from
 * another board, or a mutation made in a non-active split-pane). The old guard
 * just toasted "switch back" and returned WITHOUT popping — wedging every later
 * undo behind the stuck command, and firing even when the target board was open
 * in another pane.
 *
 * New behaviour: undo()/redo() ask a registered `boardActivator` to bring the
 * originating board into focus. If it's open (activator returns true) the
 * undo/redo proceeds against it (the command carries its own boardId). If it
 * isn't open anywhere, the switch-back toast still fires and the command stays
 * on the stack (reachable once the user opens that board) — never silently
 * discarded.
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
  execute(): void {
    this.executeCount += 1;
  }
  undo(): void {
    this.undoCount += 1;
  }
}

function switchBackToasts(spy: MockInstance<typeof uiStore.toast>): unknown[] {
  return spy.mock.calls.filter(
    (args) => typeof args[0] === 'string' && (args[0] as string).includes('the originating board'),
  );
}

describe('history auto-switch to the originating board', () => {
  let toastSpy: MockInstance<typeof uiStore.toast>;

  beforeEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(500);
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null);
    toastSpy.mockRestore();
  });

  it('undo auto-switches to the target board when the activator reports it open, then undoes it', async () => {
    historyStore.setActiveBoard('board-B');
    const activated: string[] = [];
    historyStore.setBoardActivator((boardId) => {
      activated.push(boardId);
      return true;
    });

    const cmd = new BoardScopedCommand('board-A');
    historyStore.pushWithoutExecute(cmd);

    await historyStore.undo();

    expect(activated).toEqual(['board-A']); // asked to focus the originating board
    expect(cmd.undoCount).toBe(1); // the undo actually ran
    expect(historyStore.canUndo).toBe(false); // command was popped, stack not wedged
    expect(switchBackToasts(toastSpy).length).toBe(0); // no wedge toast
  });

  it('undo keeps the toast and leaves the command on the stack when the board is not open', async () => {
    historyStore.setActiveBoard('board-B');
    historyStore.setBoardActivator(() => false); // not open anywhere

    const cmd = new BoardScopedCommand('board-A');
    historyStore.pushWithoutExecute(cmd);

    await historyStore.undo();

    expect(cmd.undoCount).toBe(0);
    expect(historyStore.canUndo).toBe(true); // NOT popped — stays reachable
    expect(switchBackToasts(toastSpy).length).toBe(1);
  });

  it('with no activator registered, falls back to the switch-back toast (legacy behaviour)', async () => {
    historyStore.setActiveBoard('board-B');
    const cmd = new BoardScopedCommand('board-A');
    historyStore.pushWithoutExecute(cmd);

    await historyStore.undo();

    expect(cmd.undoCount).toBe(0);
    expect(historyStore.canUndo).toBe(true);
    expect(switchBackToasts(toastSpy).length).toBe(1);
  });

  it('does not invoke the activator when the head command already targets the active board', async () => {
    historyStore.setActiveBoard('board-A');
    const activated: string[] = [];
    historyStore.setBoardActivator((boardId) => {
      activated.push(boardId);
      return true;
    });

    const cmd = new BoardScopedCommand('board-A');
    historyStore.pushWithoutExecute(cmd);
    await historyStore.undo();

    expect(activated).toEqual([]); // same-board undo never consults the hook
    expect(cmd.undoCount).toBe(1);
  });

  it('redo auto-switches to the target board when the activator reports it open', async () => {
    historyStore.setActiveBoard('board-B');
    const activated: string[] = [];
    historyStore.setBoardActivator((boardId) => {
      activated.push(boardId);
      return true;
    });

    // Seed the redo stack by execute→undo while the target matches the active
    // board (so neither leg trips the guard), then re-point so redo trips it.
    const cmd = new RetargettableCommand('board-B');
    await historyStore.execute(cmd);
    await historyStore.undo();
    expect(cmd.executeCount).toBe(1);
    expect(historyStore.canRedo).toBe(true);
    expect(activated).toEqual([]); // same-board legs didn't consult the hook

    cmd.retarget('board-A');
    await historyStore.redo();

    expect(activated).toEqual(['board-A']);
    expect(cmd.executeCount).toBe(2); // redo re-executed it
    expect(historyStore.canRedo).toBe(false);
    expect(switchBackToasts(toastSpy).length).toBe(0);
  });
});

describe('facade body waits for the pane pivot to re-point the scope', () => {
  beforeEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(500);
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null);
  });

  // A facade-style command records which board the history store considered
  // active AT THE MOMENT ITS BODY RAN — the proxy for "which scope a Mind-Map
  // facade command would have mutated."
  class ScopeProbeCommand extends Command {
    description = 'scope-probe';
    readonly targetBoardId: string;
    activeAtUndo: string | null = '<unset>' as unknown as string | null;
    activeAtRedo: string | null = '<unset>' as unknown as string | null;
    constructor(boardId: string) {
      super();
      this.targetBoardId = boardId;
    }
    execute(): void {
      this.activeAtRedo = historyStore.activeBoardId;
    }
    undo(): void {
      this.activeAtUndo = historyStore.activeBoardId;
    }
  }

  // The real PaneView $effect re-points the scope + calls setActiveBoard several
  // microtask hops after the activator switches panes (the Svelte scheduler
  // flushes the pane effect on a later tick). Model that as a MULTI-hop delay so
  // the settle LOOP is genuinely required — a single `await` before the body
  // would still observe the stale board.
  function repointAfterHops(id: string, hops: number): void {
    let remaining = hops;
    const step = (): void => {
      if (remaining-- <= 0) historyStore.setActiveBoard(id);
      else queueMicrotask(step);
    };
    queueMicrotask(step);
  }

  it('undo defers the body until activeBoardId reflects the target board', async () => {
    historyStore.setActiveBoard('board-B');
    historyStore.setBoardActivator((id) => {
      repointAfterHops(id, 4);
      return true;
    });

    const cmd = new ScopeProbeCommand('board-A');
    historyStore.pushWithoutExecute(cmd);
    await historyStore.undo();

    // The body ran AFTER the multi-hop scope re-point — pre-fix (or with a
    // single pre-body await) it observed the stale 'board-B'.
    expect(cmd.activeAtUndo).toBe('board-A');
  });

  it('does not stall the common same-board undo (no auto-switch, runs immediately)', async () => {
    historyStore.setActiveBoard('board-A');
    const cmd = new ScopeProbeCommand('board-A');
    historyStore.pushWithoutExecute(cmd);
    await historyStore.undo();
    expect(cmd.activeAtUndo).toBe('board-A');
  });

  it('redo defers the body until activeBoardId reflects the target board', async () => {
    historyStore.setActiveBoard('board-A');
    let switched = false;
    historyStore.setBoardActivator((id) => {
      repointAfterHops(id, 4);
      switched = true;
      return true;
    });
    // Seed a redo entry while same-board (no guard trip), then re-point.
    const cmd = new ScopeProbeCommand('board-A');
    await historyStore.execute(cmd);
    await historyStore.undo();
    expect(switched).toBe(false); // same-board legs didn't consult the hook

    historyStore.setActiveBoard('board-C');
    await historyStore.redo();
    expect(cmd.activeAtRedo).toBe('board-A');
  });
});
