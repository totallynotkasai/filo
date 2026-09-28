/**
 * D.5 — when `BatchCommand`'s rollback path itself throws on one or more
 * undo() calls, the user gets a danger-tinted modal instead of (or in
 * addition to) per-child toasts. The modal forces acknowledgement of the
 * inconsistent state so the user knows to close without saving.
 *
 * Per-child reportError → toast still fires for every individual rollback
 * failure; the modal is a higher-priority *summary* surface.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeCommand } from '../helpers/fakeCommand';
import { BatchCommand } from '@renderer/commands/index';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { Command } from '@renderer/stores/history.svelte';

interface CountingCommand extends Command {
  executed: number;
  undone: number;
}

function makeCmd(description: string, opts: { exThrows?: boolean; undoThrows?: boolean } = {}): CountingCommand {
  const cmd: CountingCommand = fakeCommand({
    description,
    executed: 0,
    undone: 0,
    execute() {
      cmd.executed += 1;
      if (opts.exThrows) throw new Error(`${description} execute threw`);
    },
    undo() {
      cmd.undone += 1;
      if (opts.undoThrows) throw new Error(`${description} undo threw`);
    },
  });
  return cmd;
}

describe('BatchCommand — D.5 rollback failure modal', () => {
  beforeEach(() => {
    uiStore.closeConfirm();
    // Silence the reportError toast spam in stderr.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    uiStore.closeConfirm();
    vi.restoreAllMocks();
  });

  // Polish phase 2.2 — `BatchCommand.execute()` / `undo()` are now async,
  // so error propagation flows through Promise rejection rather than a
  // sync throw. Test sites switch from `expect(() => ...).toThrow()` to
  // `await expect(...).rejects.toThrow()`.
  it('opens a danger confirm modal when rollback children throw during execute()', async () => {
    const flakyUndo = makeCmd('flaky', { undoThrows: true });
    const fine = makeCmd('fine');
    const bomb = makeCmd('bomb', { exThrows: true });
    const batch = new BatchCommand('test-batch', [fine, flakyUndo, bomb]);

    await expect(batch.execute()).rejects.toThrow('bomb execute threw');

    const modal = uiStore.confirmDialog;
    expect(modal).toBeDefined();
    expect(modal?.title).toBe('Inconsistent state');
    expect(modal?.danger).toBe(true);
    expect(modal?.body).toContain('test-batch');
    expect(modal?.body).toContain('flaky');
    expect(modal?.body).toContain('undo');
  });

  it('does NOT open the modal when execute() throws but rollback succeeds', async () => {
    const a = makeCmd('a');
    const b = makeCmd('b');
    const bomb = makeCmd('bomb', { exThrows: true });
    const batch = new BatchCommand('clean-rollback', [a, b, bomb]);

    await expect(batch.execute()).rejects.toThrow('bomb execute threw');

    // Rollback succeeded — no modal.
    expect(uiStore.confirmDialog).toBeNull();
  });

  it('opens the modal when undo() rollback path throws during batch.undo()', async () => {
    // Setup so undo walks: bomb-undo (throws first) ⇐ NO; we need a
    // sequence where at least one undo succeeds before the throw, and
    // then its re-execute in the rollback path throws.
    //
    // Reverse-iteration order means commands[last] gets undone first.
    // So with [A_throws_on_undo, B_works, C_works_but_throws_on_reexecute]:
    //   undo i=2 → C.undo() ok → undone=[C]
    //   undo i=1 → B.undo() ok → undone=[C, B]
    //   undo i=0 → A.undo() THROWS
    //   rollback: re-execute undone in reverse: B.execute() ok,
    //             then C.execute() THROWS → opens modal.
    const a = makeCmd('a-throws-undo', { undoThrows: true });
    const b = makeCmd('b-fine');
    const c = makeCmd('c-throws-reexec');
    // c re-execute throws on the SECOND call (the rollback re-execute).
    let cExecCount = 0;
    c.execute = () => {
      cExecCount += 1;
      c.executed += 1;
      if (cExecCount === 2) throw new Error('c re-execute threw');
    };
    const batch = new BatchCommand('undo-batch', [a, b, c]);

    // Initial execute — all three run, no throw.
    await batch.execute();
    expect(cExecCount).toBe(1);

    await expect(batch.undo()).rejects.toThrow('a-throws-undo undo threw');

    const modal = uiStore.confirmDialog;
    expect(modal).toBeDefined();
    expect(modal?.title).toBe('Inconsistent state');
    expect(modal?.body).toContain('undo-batch');
    expect(modal?.body).toContain('c-throws-reexec');
    expect(modal?.body).toContain('execute');
  });
});
