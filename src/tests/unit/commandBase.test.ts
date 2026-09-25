import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { Command } from '@renderer/commands/Command';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';

/**
 * Command base class + history-store stack tests:
 *  1. Patches/snapshots stored on a command instance never share inner
 *     references with the caller-side value — a post-construction mutation
 *     of the caller-side object cannot leak into the snapshot.
 *  2. Dropping history (redo-clear, a lowered cap) shows at most the plain
 *     "limit reached" toast: deleted files sit in the trash, so nothing is lost.
 *  3. BatchCommand whose 2nd child throws does NOT land on the undo stack,
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
});

describe('UpdateCardFieldCommand / UpdateTaskFieldCommand — patch deep-clone', () => {
  it('inverse patches never share references with the caller-side patch', async () => {
    // Import after vitest setup so the mocks below are picked up.
    const { UpdateCardFieldCommand } = await import('@renderer/commands/kanbanCommands');
    const { UpdateTaskFieldCommand } = await import('@renderer/commands/taskCommands');

    // Construct each command with a patch / inversePatch whose nested
    // `tags` array we'll mutate post-construction. The constructor
    // deep-clones via `this.snapshot(...)`, so a post-mutation of the
    // caller-side array can NOT leak into the command's stored deltas.
    const patch = { tags: ['old-tag'] };
    const inversePatch = { tags: ['restored'] };

    const cardCmd = new UpdateCardFieldCommand('b1', 'a.md', patch, inversePatch);
    const taskCmd = new UpdateTaskFieldCommand('b1', 'a.md', patch, inversePatch);

    // Mutate the caller-side arrays AFTER construction. A shallow copy
    // would share the inner `tags` ref with the live caller, and the
    // mutation here would silently appear inside the stored inverse on undo.
    patch.tags.push('post-construction-leak');
    inversePatch.tags.push('post-construction-leak');

    // Probe the private `forward` / `inverse` deltas via JSON serialisation
    // to verify detachment without exposing internals.
    const cardSnapshot = JSON.parse(JSON.stringify(cardCmd));
    const taskSnapshot = JSON.parse(JSON.stringify(taskCmd));

    expect(cardSnapshot.forward.set.tags).toEqual(['old-tag']);
    expect(cardSnapshot.inverse.set.tags).toEqual(['restored']);
    expect(taskSnapshot.forward.set.tags).toEqual(['old-tag']);
    expect(taskSnapshot.inverse.set.tags).toEqual(['restored']);
  });
});

describe('historyStore — dropping history of a delete shows only the ordinary limit toast', () => {
  // Deleted files wait in Filo's trash, so a delete command falling off the
  // history loses nothing: there is no escalated "cannot be restored" warning,
  // only the plain one-shot limit toast when the cap first drops an entry.
  let toastSpy: MockInstance<typeof uiStore.toast>;

  function toastTexts(): string[] {
    return toastSpy.mock.calls.map((args) => String(args[0]));
  }

  beforeEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(500);
    historyStore.setActiveBoard('b-drop');
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(500);
    historyStore.setActiveBoard(null);
    toastSpy.mockRestore();
  });

  it('a redo-clear that drops an undone command toasts nothing', async () => {
    await historyStore.execute(new NoopCommand());
    await historyStore.undo();
    expect(historyStore.canRedo).toBe(true);

    await historyStore.execute(new NoopCommand());

    expect(historyStore.canRedo).toBe(false);
    expect(toastTexts()).toEqual([]);
  });

  it('lowering the cap drops old entries without any loss toast', async () => {
    for (let i = 0; i < 15; i++) await historyStore.execute(new NoopCommand());

    historyStore.setMaxHistory(10);

    expect(toastTexts().some((t) => /cannot be restored/i.test(t))).toBe(false);
  });

  it('pushing past the cap shows the plain limit toast once', async () => {
    historyStore.setMaxHistory(10);
    for (let i = 0; i < 12; i++) await historyStore.execute(new NoopCommand());

    const limit = toastTexts().filter((t) => t.includes('Undo history limit reached'));
    expect(limit.length).toBe(1);
    expect(toastTexts().some((t) => /cannot be restored/i.test(t))).toBe(false);
  });
});

describe('historyStore.execute — push-after-settle', () => {
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
    // call. This contract holds: sync commands commit on the
    // same tick so callers + tests don't have to switch to async.
    expect(historyStore.canUndo).toBe(true);
  });
});
