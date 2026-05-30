import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from '@renderer/commands/Command';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';

/**
 * Phase R3 — Command base class + history-store mutateStack tests.
 *
 * Covers the four acceptance criteria from REFACTOR_PLAN_2026-05-26 Phase R3:
 *  1. Patches/snapshots stored on a command instance never share inner
 *     references with the caller-side value — a post-construction mutation
 *     of the caller-side object cannot leak into the snapshot.
 *  2. A new command executed after Ctrl+Z'ing a DeleteTilesCommand with file
 *     snapshots fires the escalated "deleted files cannot be restored" toast
 *     (file-snapshot loss via redo-clear).
 *  3. `setMaxHistory(small)` while a command with file snapshots sits in the
 *     about-to-be-dropped head of the stack fires the same toast.
 *  4. BatchCommand whose 2nd child throws does NOT land on the undo stack,
 *     so a subsequent Ctrl+Z is a no-op (not a double-undo of the rolled-back
 *     children).
 */

/** Minimal concrete command for testing the base class's snapshot helper. */
class SnapshotProbe extends Command {
  description = 'snapshot-probe';
  taken: unknown;
  constructor(input: unknown) {
    super();
    this.taken = this.snapshot(input);
  }
  execute(): void {}
  undo(): void {}
}

/** Minimal Command with a `hasFileSnapshots() => true` override. */
class FakeFileSnapshotCommand extends Command {
  description = 'fake-file-snapshot';
  execute(): void {}
  undo(): void {}
  hasFileSnapshots(): boolean {
    return true;
  }
}

class NoopCommand extends Command {
  description = 'noop';
  execute(): void {}
  undo(): void {}
}

describe('Command.snapshot — deep-clone helper', () => {
  it('detaches nested object references', () => {
    const original = { tags: ['a', 'b'], position: { x: 1, y: 2 } };
    const probe = new SnapshotProbe(original);
    const taken = probe.taken as typeof original;

    // Mutate the original AFTER construction.
    original.tags.push('c');
    original.position.x = 999;

    // The snapshot held by the probe must reflect pre-mutation state.
    expect(taken.tags).toEqual(['a', 'b']);
    expect(taken.position).toEqual({ x: 1, y: 2 });
  });

  it('detaches nested array references', () => {
    const inner = { foo: 'bar' };
    const original = { items: [inner] };
    const probe = new SnapshotProbe(original);
    const taken = probe.taken as { items: { foo: string }[] };

    inner.foo = 'mutated';
    original.items.push({ foo: 'extra' });

    expect(taken.items).toEqual([{ foo: 'bar' }]);
  });

  it('subclasses without a `hasFileSnapshots()` override default to absent — callers reach it via optional chaining', () => {
    const probe = new SnapshotProbe({});
    // The interface declares `hasFileSnapshots?(): boolean` as optional;
    // subclasses that don't override it have no implementation. Callers
    // always use `command.hasFileSnapshots?.() ?? false` (see
    // history.svelte.ts), so the contract is "absent === false".
    expect(probe.hasFileSnapshots?.() ?? false).toBe(false);
  });
});

describe('UpdateCardFieldCommand / UpdateTaskFieldCommand — patch deep-clone (Phase R3 acceptance #1)', () => {
  it('inverse patches never share references with the caller-side patch', async () => {
    // Import after vitest setup so the mocks below are picked up.
    const { UpdateCardFieldCommand } = await import('@renderer/commands/kanbanCommands');
    const { UpdateTaskFieldCommand } = await import('@renderer/commands/taskCommands');

    // Construct each command with a patch / inversePatch whose nested
    // `tags` array we'll mutate post-construction. Phase R3's headline
    // fix is that the constructor deep-clones via `this.snapshot(...)`,
    // so a post-mutation of the caller-side array can NOT leak into the
    // command's stored snapshot.
    const patch = { tags: ['old-tag'] };
    const inversePatch = { tags: ['restored'] };

    const cardCmd = new UpdateCardFieldCommand('b1', 'a.md', 'doc-1', patch, inversePatch);
    const taskCmd = new UpdateTaskFieldCommand('b1', 'a.md', 'doc-1', patch, inversePatch);

    // Mutate the caller-side arrays AFTER construction. Pre-R3, the
    // commands held shallow `{ ...patch }` so the inner `tags` ref was
    // shared with the live caller; the mutation here would silently
    // appear inside the command's stored inverse on undo.
    patch.tags.push('post-construction-leak');
    inversePatch.tags.push('post-construction-leak');

    // Probe the private fields via JSON serialisation to verify
    // detachment without exposing internals.
    const cardSnapshot = JSON.parse(JSON.stringify(cardCmd));
    const taskSnapshot = JSON.parse(JSON.stringify(taskCmd));

    expect(cardSnapshot.patch.tags).toEqual(['old-tag']);
    expect(cardSnapshot.inversePatch.tags).toEqual(['restored']);
    expect(taskSnapshot.patch.tags).toEqual(['old-tag']);
    expect(taskSnapshot.inversePatch.tags).toEqual(['restored']);
  });
});

describe('historyStore — redo-clear file-snapshot escalation (Phase R3 acceptance #2)', () => {
  let toastSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(500);
    historyStore.setActiveBoard('b-file');
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    toastSpy.mockRestore();
  });

  it('fires the escalated toast when a redo-clear drops a file-snapshot command', async () => {
    // 1. Execute a file-snapshot command (lands on undoStack).
    const fileCmd = new FakeFileSnapshotCommand();
    await historyStore.execute(fileCmd);
    expect(historyStore.canUndo).toBe(true);

    // 2. Ctrl+Z it (moves to redoStack).
    await historyStore.undo();
    expect(historyStore.canUndo).toBe(false);
    expect(historyStore.canRedo).toBe(true);

    // 3. Execute a new command — the redoStack is cleared, dropping the
    //    file-snapshot command. The escalation toast should fire.
    await historyStore.execute(new NoopCommand());

    const lossCalls = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string'
      && args[0].includes('deleted files older than this point cannot be restored'),
    );
    expect(lossCalls.length).toBe(1);
  });

  it('does NOT fire the escalated toast when the cleared redo entry has no file snapshots', async () => {
    await historyStore.execute(new NoopCommand());
    await historyStore.undo();
    expect(historyStore.canRedo).toBe(true);

    // Push a fresh command — clears the redo stack. The cleared entry
    // is a NoopCommand (no file snapshots), so no escalation.
    await historyStore.execute(new NoopCommand());

    const lossCalls = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string'
      && args[0].includes('deleted files older than this point cannot be restored'),
    );
    expect(lossCalls.length).toBe(0);
  });
});

describe('historyStore.setMaxHistory — truncation file-snapshot escalation (Phase R3 acceptance #3)', () => {
  let toastSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(500);
    historyStore.setActiveBoard('b-trunc');
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(500);
    historyStore.setActiveBoard(null);
    toastSpy.mockRestore();
  });

  it('fires the escalated toast when setMaxHistory drops a file-snapshot command', async () => {
    // The audit example: a 15-deep stack with a file-snapshot command at
    // index 0; lower the cap to 10 — drops the 5 oldest entries, one of
    // which carries file snapshots. (10 is the minimum the slider clamps
    // to, matching the production cap floor.)
    await historyStore.execute(new FakeFileSnapshotCommand());
    for (let i = 0; i < 14; i++) await historyStore.execute(new NoopCommand());

    expect(historyStore.canUndo).toBe(true);

    historyStore.setMaxHistory(10);

    const lossCalls = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string'
      && args[0].includes('deleted files older than this point cannot be restored'),
    );
    expect(lossCalls.length).toBe(1);
  });

  it('does NOT fire the escalated toast when truncated entries have no file snapshots', async () => {
    for (let i = 0; i < 15; i++) await historyStore.execute(new NoopCommand());

    historyStore.setMaxHistory(10);

    const lossCalls = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string'
      && args[0].includes('deleted files older than this point cannot be restored'),
    );
    expect(lossCalls.length).toBe(0);
  });
});

describe('historyStore.execute — push-after-settle (Phase R3 acceptance #4)', () => {
  beforeEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(500);
    historyStore.setActiveBoard('b-batch');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
  });

  it('a command whose execute() throws synchronously does NOT land on the undo stack', async () => {
    const bomb = new (class extends Command {
      description = 'sync-bomb';
      execute(): void {
        throw new Error('boom');
      }
      undo(): void {}
    })();

    await expect(historyStore.execute(bomb)).rejects.toThrow('boom');
    expect(historyStore.canUndo).toBe(false);
  });

  it('a command whose execute() rejects asynchronously does NOT land on the undo stack', async () => {
    const bomb = new (class extends Command {
      description = 'async-bomb';
      async execute(): Promise<void> {
        await Promise.resolve();
        throw new Error('async boom');
      }
      undo(): void {}
    })();

    await expect(historyStore.execute(bomb)).rejects.toThrow('async boom');
    expect(historyStore.canUndo).toBe(false);
  });

  it('a BatchCommand whose 2nd child throws does NOT land on the stack — subsequent Ctrl+Z is a no-op', async () => {
    const { BatchCommand } = await import('@renderer/commands/groupAndBoardCommands');

    let cleanChildExecuted = 0;
    let cleanChildUndone = 0;
    const cleanChild = new (class extends Command {
      description = 'clean';
      execute(): void { cleanChildExecuted++; }
      undo(): void { cleanChildUndone++; }
    })();
    const throwingChild = new (class extends Command {
      description = 'thrower';
      execute(): void { throw new Error('batch child threw'); }
      undo(): void {}
    })();

    const batch = new BatchCommand('two-child-batch', [cleanChild, throwingChild]);
    await expect(historyStore.execute(batch)).rejects.toThrow('batch child threw');

    // The batch's internal rollback already undid the clean child (the
    // BatchCommand catches a child throw and undoes the executed prefix).
    expect(cleanChildExecuted).toBe(1);
    expect(cleanChildUndone).toBe(1);

    // The batch must NOT be on the undo stack — its body rejected, so
    // push-after-settle skipped the commit step.
    expect(historyStore.canUndo).toBe(false);

    // Ctrl+Z should be a no-op (no commands to undo).
    await historyStore.undo();
    expect(cleanChildUndone).toBe(1); // still 1, not 2
  });
});

describe('historyStore.execute — sync commands still commit synchronously', () => {
  beforeEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard('b-sync');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
  });

  it('canUndo is true immediately after a sync execute(), without awaiting', () => {
    historyStore.execute(new NoopCommand());
    // No await — the assertion runs in the SAME microtask as the execute
    // call. Phase R3 preserves this contract: sync commands commit on the
    // same tick so callers + tests don't have to switch to async.
    expect(historyStore.canUndo).toBe(true);
  });
});
