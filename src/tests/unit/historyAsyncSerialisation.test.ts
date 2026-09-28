import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fakeCommand } from '../helpers/fakeCommand';
import { historyStore, type Command } from '@renderer/stores/history.svelte';

/**
 * Phase C / C.1 — historyStore.execute / undo / redo serialise async
 * command bodies so a rapid Apply → Undo can't overlap the prior
 * command's flush+merge+schedule sequence with the next one's.
 *
 * Pins two contracts:
 *
 *  1. Sync commands still run synchronously. The pre-existing test in
 *     historyGetActiveStackPure.test.ts covers `executed === true`
 *     immediately after `historyStore.execute(syncCmd)`. We don't
 *     duplicate that here — we just verify the async path layered on
 *     top of it doesn't break the sync contract.
 *
 *  2. When an async command's `execute()` promise is still pending,
 *     the next call's body must not run until that promise settles.
 *     This is the only behaviour change the audit's race depends on.
 */

describe('Phase C / C.1 — historyStore async command serialisation', () => {
  beforeEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard('b-c1');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
  });

  it('a sync command body runs immediately on execute()', () => {
    let executed = false;
    historyStore.execute(fakeCommand({
      description: 'sync',
      execute: () => { executed = true; },
      undo: () => {},
    }));
    expect(executed).toBe(true);
    expect(historyStore.canUndo).toBe(true);
  });

  it('queues a sync undo() body until the prior async execute() settles', async () => {
    const order: string[] = [];
    let resolveExecute: (() => void) | null = null;
    const executePending = new Promise<void>((res) => { resolveExecute = res; });

    const cmd: Command = fakeCommand({
      description: 'async-then-sync',
      async execute() {
        order.push('exec-start');
        await executePending;
        order.push('exec-end');
      },
      undo() {
        order.push('undo');
      },
    });

    // 1) Apply — async; suspends at await executePending.
    const execPromise = historyStore.execute(cmd);
    expect(order).toEqual(['exec-start']);

    // 2) Undo synchronously — body must NOT run yet. State (canRedo)
    // still flips because stack mutations are synchronous.
    const undoPromise = historyStore.undo();
    expect(order).toEqual(['exec-start']);
    expect(historyStore.canRedo).toBe(true);
    expect(historyStore.canUndo).toBe(false);

    // 3) Resolve execute — chained undo body now runs.
    resolveExecute!();
    await execPromise;
    await undoPromise;
    expect(order).toEqual(['exec-start', 'exec-end', 'undo']);
  });

  it('queues a sync redo() body until the prior async undo() settles', async () => {
    const order: string[] = [];
    let resolveUndo: (() => void) | null = null;
    const undoPending = new Promise<void>((res) => { resolveUndo = res; });

    const cmd: Command = fakeCommand({
      description: 'sync-exec-async-undo',
      execute() {
        order.push('exec');
      },
      async undo() {
        order.push('undo-start');
        await undoPending;
        order.push('undo-end');
      },
    });

    historyStore.execute(cmd);
    expect(order).toEqual(['exec']);

    const undoPromise = historyStore.undo();
    // undo() is async — body started, suspended at await undoPending.
    expect(order).toEqual(['exec', 'undo-start']);
    expect(historyStore.canRedo).toBe(true);

    const redoPromise = historyStore.redo();
    // Redo body (cmd.execute) must NOT run yet — prior undo still in flight.
    expect(order).toEqual(['exec', 'undo-start']);

    resolveUndo!();
    await undoPromise;
    await redoPromise;
    expect(order).toEqual(['exec', 'undo-start', 'undo-end', 'exec']);
  });

  // L31 (Audit-6) — `whenChainSettled()` is the gate `vaultStore.save()` awaits
  // before flushing, so an in-flight async command finishes scheduling its disk
  // writes before the flush pass runs (no premature "saved").
  it('L31: whenChainSettled() awaits an in-flight async command before resolving', async () => {
    let resolveExecute: (() => void) | null = null;
    const executePending = new Promise<void>((res) => { resolveExecute = res; });
    let chainSettled = false;

    const cmd: Command = fakeCommand({
      description: 'async',
      async execute() { await executePending; },
      undo() {},
    });

    const execPromise = historyStore.execute(cmd);
    // Command suspended mid-execute → the chain tail must NOT have settled.
    const settledPromise = historyStore.whenChainSettled().then(() => { chainSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(chainSettled).toBe(false);

    resolveExecute!();
    await execPromise;
    await settledPromise;
    expect(chainSettled).toBe(true);
  });

  it('L31: whenChainSettled() resolves promptly when the chain is idle', async () => {
    await expect(historyStore.whenChainSettled()).resolves.toBeUndefined();
  });
});
