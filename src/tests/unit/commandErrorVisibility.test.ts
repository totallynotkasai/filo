/**
 * 6.4.M14 / M15 — command-failure visibility.
 *
 * M14: when a BatchCommand child throws and the rollback SUCCEEDS, no danger
 * modal opens, so the root-cause error was previously swallowed past the
 * rollback (rethrown to a fire-and-forget historyStore caller with no
 * breadcrumb pinpointing which child failed). The batch now console.errors the
 * failing child + the original error.
 *
 * M15: historyStore.execute/undo/redo catch the command-body rejection, roll
 * the stack back, and rethrow — but nearly every caller fires these
 * fire-and-forget, so the rethrow surfaced only as a silent unhandled
 * rejection. The catch now reports the error through the errorBus so a failed
 * command is never invisible.
 *
 * Note: commands here are CLASS instances (extending Command), matching real
 * usage — Svelte 5 `$state` deep-proxies plain object literals, which would
 * break the `lastIndexOf(command)` reference match in `rollbackExecute`. Real
 * commands are class instances and are left unproxied.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { historyStore } from '@renderer/stores/history.svelte';
import { BatchCommand } from '@renderer/commands/index';
import { Command } from '@renderer/commands/Command';
import { onError, type ReportedError } from '@renderer/lib/utils/errorBus';

class RecordingCommand extends Command {
  readonly targetBoardId: string;
  description: string;
  constructor(
    description: string,
    private readonly opts: {
      onExecute?: () => void;
      onUndo?: () => void;
      boardId?: string;
    } = {},
  ) {
    super();
    this.description = description;
    this.targetBoardId = opts.boardId ?? '';
  }
  execute(): void {
    this.opts.onExecute?.();
  }
  undo(): void {
    this.opts.onUndo?.();
  }
}

describe('6.4.M14 — BatchCommand logs the original child failure', () => {
  it('console.errors the failing child + error even when rollback succeeds', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const undone: string[] = [];
      const good = new RecordingCommand('good-child', { onUndo: () => undone.push('good-child') });
      const boom = new Error('child exec failed');
      const bad = new RecordingCommand('bad-child', {
        onExecute: () => {
          throw boom;
        },
      });
      const batch = new BatchCommand('My batch', [good, bad], 'b');

      await expect(batch.execute()).rejects.toBe(boom);

      // Rollback ran — the already-applied good child was undone.
      expect(undone).toEqual(['good-child']);
      // M14 — the original failure is logged with the failing child + batch
      // (rollback succeeded, so no modal would otherwise surface it).
      const logged = consoleSpy.mock.calls.some(
        (args) =>
          args.includes(boom) ||
          args.some(
            (a) => typeof a === 'string' && a.includes('bad-child') && a.includes('My batch'),
          ),
      );
      expect(logged).toBe(true);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('6.4.M15 — historyStore reports a command-body failure', () => {
  beforeEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard('b-m15');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
  });

  it('reports and rolls back when execute() throws', async () => {
    const reported: ReportedError[] = [];
    const unsub = onError((e) => reported.push(e));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const boom = new Error('exec boom');
      const cmd = new RecordingCommand('throwing-exec', {
        onExecute: () => {
          throw boom;
        },
      });

      await expect(historyStore.execute(cmd)).rejects.toBe(boom);

      // M15 — reported through the errorBus (was a silent unhandled rejection).
      expect(reported.some((r) => r.error === boom && r.context === 'historyStore')).toBe(true);
      // Rolled back — the throwing command is NOT left on the undo stack.
      expect(historyStore.canUndo).toBe(false);
    } finally {
      consoleSpy.mockRestore();
      unsub();
    }
  });

  it('reports and rolls back when undo() throws', async () => {
    const reported: ReportedError[] = [];
    const unsub = onError((e) => reported.push(e));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const boom = new Error('undo boom');
      const cmd = new RecordingCommand('throwing-undo', {
        onUndo: () => {
          throw boom;
        },
      });

      await historyStore.execute(cmd);
      expect(historyStore.canUndo).toBe(true);

      await expect(historyStore.undo()).rejects.toBe(boom);

      expect(reported.some((r) => r.error === boom && r.context === 'historyStore')).toBe(true);
      // rollbackUndo restored the command to the undo stack.
      expect(historyStore.canUndo).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      unsub();
    }
  });
});
