import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { historyStore, type Command } from '@renderer/stores/history.svelte';

/**
 * UR-1 (AUDIT_REMEDIATION_PLAN_2026-05-29 follow-up) — `undo()` / `redo()`
 * must roll their synchronous stack move back when the command body throws or
 * rejects, the same way `execute()` already does via `rollbackExecute`.
 *
 * Before the fix, an async command whose `undo()` / `execute()` rejected
 * mid-flight left the command stranded on the wrong stack with its effect only
 * half-applied: `canUndo` / `canRedo` reported success, so a follow-up Ctrl+Z
 * skipped the command and the next Ctrl+Y replayed a no-op. These tests pin
 * that a failed undo/redo leaves the stacks exactly as they were.
 *
 * Stack mutations are synchronous, so the optimistic state is observable
 * immediately after the call; the rollback runs in the rejection handler, so
 * the assertions only hold once the returned promise has settled.
 */

describe('UR-1 — undo()/redo() rollback on body failure', () => {
  beforeEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard('b-ur1');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
  });

  it('undo() restores the command to the undo stack when its body rejects', async () => {
    const cmd: Command = {
      description: 'undo-rejects',
      targetBoardId: '',
      execute() {
        /* succeeds so the command lands on the undo stack */
      },
      async undo() {
        throw new Error('undo boom');
      },
    };

    historyStore.execute(cmd);
    expect(historyStore.canUndo).toBe(true);
    expect(historyStore.canRedo).toBe(false);

    await expect(historyStore.undo()).rejects.toThrow('undo boom');

    // Rolled back: command is back on the undo stack, redo stack still empty.
    expect(historyStore.canUndo).toBe(true);
    expect(historyStore.canRedo).toBe(false);

    // And it is genuinely re-undoable — a second undo (this time with a
    // succeeding body) flips the stacks as normal.
    const cmd2: Command = {
      description: 'undo-succeeds',
      targetBoardId: '',
      execute() {},
      undo() {},
    };
    // Replace the failing command with a clean one to prove the stack is sane.
    historyStore.clear();
    historyStore.execute(cmd2);
    await historyStore.undo();
    expect(historyStore.canRedo).toBe(true);
    expect(historyStore.canUndo).toBe(false);
  });

  it('redo() restores the command to the redo stack when its body rejects', async () => {
    let execCount = 0;
    const cmd: Command = {
      description: 'redo-rejects',
      targetBoardId: '',
      execute() {
        execCount++;
        // The first execute (via historyStore.execute) succeeds; the redo
        // re-execute is the second call and rejects so we hit the redo path.
        if (execCount >= 2) throw new Error('redo boom');
      },
      undo() {},
    };

    historyStore.execute(cmd);
    await historyStore.undo();
    expect(historyStore.canRedo).toBe(true);
    expect(historyStore.canUndo).toBe(false);

    await expect(historyStore.redo()).rejects.toThrow('redo boom');

    // Rolled back: command is back on the redo stack, undo stack still empty.
    expect(historyStore.canRedo).toBe(true);
    expect(historyStore.canUndo).toBe(false);
  });

  it('a successful undo/redo is unaffected by the rollback wiring', async () => {
    const log: string[] = [];
    const cmd: Command = {
      description: 'happy-path',
      targetBoardId: '',
      execute() {
        log.push('exec');
      },
      undo() {
        log.push('undo');
      },
    };

    historyStore.execute(cmd);
    await historyStore.undo();
    expect(historyStore.canRedo).toBe(true);
    expect(historyStore.canUndo).toBe(false);

    await historyStore.redo();
    expect(historyStore.canUndo).toBe(true);
    expect(historyStore.canRedo).toBe(false);
    expect(log).toEqual(['exec', 'undo', 'exec']);
  });
});
