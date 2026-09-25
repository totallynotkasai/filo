import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { Command } from '@renderer/commands/Command';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-16 Phase 2 — undo/redo corruption (history-store half).
 *
 * 2.1 `rollbackExecute` resolved the stack via `getActiveStack()` — the
 *     Audit-14 2.1 fix covered only undo()/redo(), so an async execute()
 *     body rejecting after a tab switch rolled back the WRONG board's stack
 *     (never-applied command left on the origin stack; a later Ctrl+Z
 *     replayed its inverse over state it never changed).
 * 2.4 `clearBoard` drops the closed board's OWN stack (and its commands on
 *     other stacks). Deleted files wait in Filo's trash, so this loses
 *     nothing and needs no warning toast.
 * 2.5 The pre-swap reset zeroed `chainInflightDepth` while a command body
 *     was still in flight; the body's settle handler then decremented the
 *     fresh counter to -1, permanently deferring every later command body
 *     to a microtask (silently inverting the "sync body runs synchronously"
 *     contract for the rest of the session).
 *
 * (2.2 DeleteSectionCommand tied-sibling anchor and 2.3 stale-targetSectionId
 * fallback live in sectionCommandsDelta.test.ts alongside the existing
 * section-command round-trips.)
 */

// ── Test command helpers ─────────────────────────────────────────────────────

class ScopedCommand extends Command {
  description = 'scoped';
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

/** Async execute() body the test settles manually (drives in-flight windows). */
class DeferredExecuteCommand extends Command {
  description = 'deferred-execute';
  readonly targetBoardId: string;
  resolveBody!: () => void;
  rejectBody!: (err: Error) => void;
  private bodyPromise: Promise<void>;
  constructor(boardId: string) {
    super();
    this.targetBoardId = boardId;
    this.bodyPromise = new Promise<void>((resolve, reject) => {
      this.resolveBody = resolve;
      this.rejectBody = reject;
    });
  }
  execute(): Promise<void> {
    return this.bodyPromise;
  }
  undo(): void {}
}

// ── 2.1 — rejected async execute rolls back the ORIGIN board's stack ─────────

describe('Audit-16 2.1 — rollbackExecute resolves the origin board stack', () => {
  let toastSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null);
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null);
    toastSpy.mockRestore();
  });

  it('an async execute() rejecting after a tab switch repairs board A (origin), not the switched-to board B', async () => {
    // Seed board B's own stack so we can prove it stays untouched.
    historyStore.setActiveBoard('board-B');
    const bCmd = new ScopedCommand('board-B');
    historyStore.pushWithoutExecute(bCmd); // B.undo = [bCmd]

    // Board A holds a redo entry (push + undo) so the rollback's redo
    // restoration is observable too.
    historyStore.setActiveBoard('board-A');
    const aCmd = new ScopedCommand('board-A');
    historyStore.pushWithoutExecute(aCmd);
    await historyStore.undo(); // A.undo = [], A.redo = [aCmd]
    expect(historyStore.canRedo).toBe(true);

    const cmd = new DeferredExecuteCommand('board-A');
    const pending = historyStore.execute(cmd); // synchronous commit on A
    expect(historyStore.canUndo).toBe(true); // cmd on A.undo
    expect(historyStore.canRedo).toBe(false); // commit cleared A.redo

    // The user switches tabs while the body is still in flight, THEN the
    // body rejects — exactly the window where the old getActiveStack()
    // rollback searched board B's stack and found nothing.
    historyStore.setActiveBoard('board-B');
    cmd.rejectBody(new Error('execute boom'));
    await pending.catch(() => {});

    // 2.1 — origin board A: the never-applied command was removed from its
    // undo stack and the pre-execute redo stack was restored. (Under the
    // bug, A.undo still held cmd and A.redo stayed cleared.)
    historyStore.setActiveBoard('board-A');
    expect(historyStore.canUndo).toBe(false);
    expect(historyStore.canRedo).toBe(true);

    // Board B's stack was not touched: its own command still undoes.
    historyStore.setActiveBoard('board-B');
    await historyStore.undo().catch(() => {});
    expect(bCmd.undoCount).toBe(1);
  });
});

// ── 2.4 — clearBoard drops the closed board's history quietly ──────────────

describe('Audit-16 2.4 — clearBoard drops the closed board\x27s own stack', () => {
  let toastSpy: MockInstance<typeof uiStore.toast>;
  beforeEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null);
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    toastSpy.mockRestore();
  });

  it('empties the board\x27s undo history and shows no toast', () => {
    historyStore.setActiveBoard('board-A');
    historyStore.pushWithoutExecute(new ScopedCommand('board-A'));
    expect(historyStore.canUndo).toBe(true);
    toastSpy.mockClear();

    // The board's last tab closes — its own stack is dropped.
    historyStore.clearBoard('board-A');

    historyStore.setActiveBoard('board-A');
    expect(historyStore.canUndo).toBe(false);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('leaves other boards\x27 own commands in place', () => {
    historyStore.setActiveBoard('board-B');
    historyStore.pushWithoutExecute(new ScopedCommand('board-B'));
    historyStore.setActiveBoard('board-A');
    historyStore.pushWithoutExecute(new ScopedCommand('board-A'));

    historyStore.clearBoard('board-A');

    historyStore.setActiveBoard('board-B');
    expect(historyStore.canUndo).toBe(true);
  });
});

// ── 2.5 — pre-swap reset cannot be underflowed by a late settle ───────────────

describe('Audit-16 2.5 — chainInflightDepth survives a Don\'t-Save swap with a body in flight', () => {
  beforeEach(() => {
    installFiloMock(() => null);
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null);
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    restoreFiloDefault();
  });

  it('a body settling AFTER the pre-swap reset does not defer every later command body', async () => {
    historyStore.setActiveBoard('board-A');
    const slow = new DeferredExecuteCommand('board-A');
    const pending = historyStore.execute(slow); // depth = 1, body in flight

    // Don't-Save vault swap: the pre-swap handler resets the chain while the
    // body is still pending (this branch never awaits whenChainSettled()).
    await fireVaultSwap({
      phase: 'pre-swap',
      previousVault: '/vault-A',
      nextVault: '/vault-B',
      saveOutgoing: false,
    });

    // The orphaned body settles AFTER the reset — pre-fix this decremented
    // the fresh counter to -1.
    slow.resolveBody();
    await pending;

    // A purely synchronous command body in the new vault must run
    // synchronously (the documented runChained contract). Under the bug,
    // depth === -1 routed it onto the queued branch — deferred to a
    // microtask, observable as executeCount still 0 here.
    historyStore.setActiveBoard('board-B');
    const sync = new ScopedCommand('board-B');
    void historyStore.execute(sync);
    expect(sync.executeCount).toBe(1);

    // And the regime is stable: the deferred-op's own settle (the bug's
    // re-decrement to -1) doesn't re-enter the degraded mode.
    await historyStore.whenChainSettled();
    const sync2 = new ScopedCommand('board-B');
    void historyStore.execute(sync2);
    expect(sync2.executeCount).toBe(1);
  });
});
