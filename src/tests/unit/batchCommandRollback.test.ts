import { describe, it, expect, vi } from 'vitest';
import { fakeCommand } from '../helpers/fakeCommand';
import { BatchCommand } from '@renderer/commands/index';
import type { Command } from '@renderer/stores/history.svelte';

/**
 * BatchCommand previously fired children with no
 * try/catch. A throw from child #N left children 0..N-1's mutations
 * applied while the user saw an error for the batch as a whole — a
 * silent half-applied state.
 *
 * The fix: wrap each child in try/catch and rollback the already-
 * executed children in reverse order on any throw, then rethrow so the
 * historyStore wrapper (or direct caller) sees the original failure.
 */

interface CountingCommand extends Command {
  executed: number;
  undone: number;
}

function makeCountingCommand(description: string, throws = false): CountingCommand {
  const cmd: CountingCommand = fakeCommand({
    description,
    executed: 0,
    undone: 0,
    execute() {
      cmd.executed += 1;
      if (throws) throw new Error(`${description} threw`);
    },
    undo() {
      cmd.undone += 1;
    },
  });
  return cmd;
}

describe('BatchCommand atomic execute + undo', () => {
  // `BatchCommand.execute()` and `undo()` are async so children with async
  // return values (DeleteTilesCommand.undo, RenameTitleCommand,
  // UpdateTilePathCommand, etc.) are awaited per-child during both the
  // forward and rollback loops. The expectations below use
  // `expect(...).rejects.toThrow()` because the thrown error propagates as a
  // rejected promise, not a sync throw.
  it('happy path: every child runs and is reversible', async () => {
    const a = makeCountingCommand('a');
    const b = makeCountingCommand('b');
    const c = makeCountingCommand('c');
    const batch = new BatchCommand('happy', [a, b, c]);
    await batch.execute();
    expect([a.executed, b.executed, c.executed]).toEqual([1, 1, 1]);
    await batch.undo();
    expect([a.undone, b.undone, c.undone]).toEqual([1, 1, 1]);
  });

  it('execute() throwing child rolls back already-executed children in reverse order', async () => {
    const a = makeCountingCommand('a');
    const b = makeCountingCommand('b');
    const bomb = makeCountingCommand('bomb', true);
    const d = makeCountingCommand('d');
    const batch = new BatchCommand('rollback', [a, b, bomb, d]);

    await expect(batch.execute()).rejects.toThrow('bomb threw');

    // a, b ran; bomb tried (counted then threw); d never ran.
    expect(a.executed).toBe(1);
    expect(b.executed).toBe(1);
    expect(bomb.executed).toBe(1);
    expect(d.executed).toBe(0);

    // Rollback: b undone (executed[1]), then a undone (executed[0]). bomb
    // is NOT undone — its execute() threw before completing, so it never
    // joined the executed[] list.
    expect(b.undone).toBe(1);
    expect(a.undone).toBe(1);
    expect(bomb.undone).toBe(0);
    expect(d.undone).toBe(0);
  });

  it('undo() throwing child re-executes already-undone children in reverse order', async () => {
    const a = makeCountingCommand('a');
    const b = makeCountingCommand('b');
    const c = makeCountingCommand('c');
    const batch = new BatchCommand('symmetric', [a, b, c]);

    await batch.execute();
    expect([a.executed, b.executed, c.executed]).toEqual([1, 1, 1]);

    // Make `a.undo()` throw — when undo walks c → b → a, c and b will be
    // undone, then a throws → rollback re-executes c, b.
    a.undo = () => { throw new Error('a undo threw'); };
    const cExecBefore = c.executed;
    const bExecBefore = b.executed;

    await expect(batch.undo()).rejects.toThrow('a undo threw');

    // c and b were undone; a failed; rollback re-executed b and c.
    expect(c.executed).toBe(cExecBefore + 1);
    expect(b.executed).toBe(bExecBefore + 1);
  });

  it('rollback continues even if undo() of a previously-executed child also throws', async () => {
    const fineUndo = makeCountingCommand('fine');
    const flakyUndo = makeCountingCommand('flaky');
    flakyUndo.undo = () => { throw new Error('flaky undo failed'); };
    const bomb = makeCountingCommand('bomb', true);
    const batch = new BatchCommand('best-effort-rollback', [fineUndo, flakyUndo, bomb]);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(batch.execute()).rejects.toThrow('bomb threw');

    // Rollback walks executed in reverse: flakyUndo.undo() → throws but is
    // swallowed (best-effort, reported via errorBus); fineUndo.undo() still
    // runs.
    expect(fineUndo.undone).toBe(1);

    errorSpy.mockRestore();
  });
});

describe('BatchCommand awaits async children', () => {
  it('rollback awaits each child undo() Promise before invoking the next', async () => {
    // Simulate the DeleteTilesCommand shape: a child whose undo() returns a
    // delayed Promise. The rollback must NOT advance to the next child
    // until the current child's undo settles. Without the await in the
    // rollback loop, the snapshot-write Promise would race the subsequent
    // rollback steps and the rethrow — exactly the silent-failure window
    // the await closes.
    const order: string[] = [];
    const makeAsyncChild = (name: string): Command => (fakeCommand({
      description: name,
      execute() {
        order.push(`${name}:execute`);
      },
      async undo() {
        order.push(`${name}:undo:start`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`${name}:undo:end`);
      },
    }));
    const bomb: Command = fakeCommand({
      description: 'bomb',
      execute() {
        order.push('bomb:execute');
        throw new Error('bomb threw');
      },
      undo() {
        order.push('bomb:undo');
      },
    });

    const a = makeAsyncChild('a');
    const b = makeAsyncChild('b');
    const batch = new BatchCommand('async-rollback', [a, b, bomb]);

    await expect(batch.execute()).rejects.toThrow('bomb threw');

    // Forward: a executes, b executes, bomb tries → throws.
    // Rollback (reverse): b's undo runs and FULLY settles, then a's undo
    // runs and FULLY settles. If awaits were missing, the start/end pairs
    // would interleave across children.
    expect(order).toEqual([
      'a:execute',
      'b:execute',
      'bomb:execute',
      'b:undo:start',
      'b:undo:end',
      'a:undo:start',
      'a:undo:end',
    ]);
  });

  it('a child whose undo() rejects still allows the remaining rollback children to run', async () => {
    // Best-effort cleanup: when one child's undo throws OR rejects, the
    // BatchCommand reports it but continues attempting the others.
    const order: string[] = [];
    const failingChild: Command = fakeCommand({
      description: 'rejecting',
      execute() {
        order.push('rejecting:execute');
      },
      async undo() {
        order.push('rejecting:undo:start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('async undo rejected');
      },
    });
    const finalChild: Command = fakeCommand({
      description: 'fine',
      execute() {
        order.push('fine:execute');
      },
      undo() {
        order.push('fine:undo');
      },
    });
    const bomb: Command = fakeCommand({
      description: 'bomb',
      execute() {
        order.push('bomb:execute');
        throw new Error('bomb threw');
      },
      undo() {},
    });

    const batch = new BatchCommand('async-rollback-failure', [finalChild, failingChild, bomb]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(batch.execute()).rejects.toThrow('bomb threw');

    // Forward: finalChild, failingChild, bomb (throws).
    // Rollback walks reverse: failingChild.undo (rejects, swallowed via
    // reportError), then finalChild.undo (runs to completion).
    expect(order).toEqual([
      'fine:execute',
      'rejecting:execute',
      'bomb:execute',
      'rejecting:undo:start',
      'fine:undo',
    ]);

    errSpy.mockRestore();
  });
});
