import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from '@renderer/commands/Command';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';

/**
 * An undo queued behind a running command runs later, when another board may
 * be active. It must run on its own board (switching back first), or come
 * back to the stack when that board was closed meanwhile. And an Undo offered
 * on a toast undoes its own step, never whatever landed on top since.
 */

class BoardCommand extends Command {
  description = 'board command';
  readonly targetBoardId: string;
  undoneOn: Array<string | null> = [];
  constructor(boardId: string) {
    super();
    this.targetBoardId = boardId;
  }
  execute(): void {}
  undo(): void {
    this.undoneOn.push(historyStore.activeBoardId);
  }
}

/** A command whose execute holds the history chain until `release()`. */
class SlowCommand extends Command {
  description = 'slow';
  readonly targetBoardId: string;
  private releaseFn: () => void = () => {};
  constructor(boardId: string) {
    super();
    this.targetBoardId = boardId;
  }
  execute(): Promise<void> {
    return new Promise((resolve) => {
      this.releaseFn = resolve;
    });
  }
  undo(): void {}
  release(): void {
    this.releaseFn();
  }
}

describe('an undo queued behind a running command', () => {
  let toastSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    historyStore.clear();
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null);
    toastSpy.mockRestore();
  });

  it('switches back to its own board before its body runs', async () => {
    historyStore.setBoardActivator((id) => {
      historyStore.setActiveBoard(id);
      return true;
    });
    // A command still running on board Z holds the chain.
    historyStore.setActiveBoard('Z');
    const slow = new SlowCommand('Z');
    void historyStore.execute(slow).catch(() => {});
    historyStore.setActiveBoard('A');
    const cmd = new BoardCommand('A');
    historyStore.pushWithoutExecute(cmd);

    const undone = historyStore.undo();
    // The user switches to board B while the undo waits its turn.
    historyStore.setActiveBoard('B');
    slow.release();
    await undone;

    expect(cmd.undoneOn).toEqual(['A']);
  });

  it('comes back to the stack with a toast when its board was closed meanwhile', async () => {
    historyStore.setBoardActivator(() => false);
    historyStore.setActiveBoard('Z');
    const slow = new SlowCommand('Z');
    void historyStore.execute(slow).catch(() => {});
    historyStore.setActiveBoard('A');
    const cmd = new BoardCommand('A');
    historyStore.pushWithoutExecute(cmd);

    const undone = historyStore.undo();
    historyStore.setActiveBoard('B');
    slow.release();
    await undone;

    expect(cmd.undoneOn).toEqual([]);
    historyStore.setActiveBoard('A');
    expect(historyStore.canUndo).toBe(true);
    expect(historyStore.canRedo).toBe(false);
    expect(toastSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('the originating board'))).toBe(true);
  });
});

/** A command that records the board active when its execute body ran. */
class ExecuteRecorder extends BoardCommand {
  executedOn: Array<string | null> = [];
  execute(): void {
    this.executedOn.push(historyStore.activeBoardId);
  }
}

describe('an execute queued behind a running command', () => {
  let toastSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    historyStore.clear();
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null);
    toastSpy.mockRestore();
  });

  it('runs on the board it was made on, after a tab switch', async () => {
    historyStore.setBoardActivator((id) => {
      historyStore.setActiveBoard(id);
      return true;
    });
    historyStore.setActiveBoard('A');
    const slow = new SlowCommand('A');
    void historyStore.execute(slow).catch(() => {});
    const add = new ExecuteRecorder('A');
    const done = historyStore.execute(add);
    // The user switches to board B while the add waits behind the slow delete.
    historyStore.setActiveBoard('B');
    slow.release();
    await done;

    expect(add.executedOn).toEqual(['A']);
  });

  it('is rolled back with a toast when its board was closed meanwhile', async () => {
    historyStore.setBoardActivator(() => false);
    historyStore.setActiveBoard('A');
    const slow = new SlowCommand('A');
    void historyStore.execute(slow).catch(() => {});
    const add = new ExecuteRecorder('A');
    const done = historyStore.execute(add);
    historyStore.setActiveBoard('B');
    slow.release();
    await done;

    expect(add.executedOn).toEqual([]);
    historyStore.setActiveBoard('A');
    // Only the slow command is left on A's stack.
    await historyStore.undo();
    expect(historyStore.canUndo).toBe(false);
    expect(toastSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('closed'))).toBe(true);
  });

  it('a board-agnostic or cross-board execute runs where it is, without switching', async () => {
    const switched: string[] = [];
    historyStore.setBoardActivator((id) => {
      switched.push(id);
      return true;
    });
    historyStore.setActiveBoard('A');
    const other = new ExecuteRecorder('C');
    await historyStore.execute(other);
    expect(other.executedOn).toEqual(['A']);
    expect(switched).toEqual([]);
  });
});

describe('undoIfLatest (an Undo offered on a toast)', () => {
  beforeEach(() => historyStore.clear());
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
  });

  it('undoes the step while it is still the last one on its board', () => {
    historyStore.setActiveBoard('A');
    const step = new BoardCommand('A');
    historyStore.pushWithoutExecute(step);
    expect(historyStore.undoIfLatest(step, 'A')).toBe(true);
    expect(step.undoneOn).toEqual(['A']);
  });

  it('undoes nothing once another step landed on top', () => {
    historyStore.setActiveBoard('A');
    const step = new BoardCommand('A');
    const later = new BoardCommand('A');
    historyStore.pushWithoutExecute(step);
    historyStore.pushWithoutExecute(later);
    expect(historyStore.undoIfLatest(step, 'A')).toBe(false);
    expect(step.undoneOn).toEqual([]);
    expect(later.undoneOn).toEqual([]);
  });

  it('undoes nothing while another board is active', () => {
    historyStore.setActiveBoard('A');
    const step = new BoardCommand('A');
    historyStore.pushWithoutExecute(step);
    historyStore.setActiveBoard('B');
    const other = new BoardCommand('B');
    historyStore.pushWithoutExecute(other);
    expect(historyStore.undoIfLatest(step, 'A')).toBe(false);
    expect(other.undoneOn).toEqual([]);
  });
});
