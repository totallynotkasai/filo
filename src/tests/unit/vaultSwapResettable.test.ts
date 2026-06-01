import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  vaultSwapResettable,
  onVaultSwap,
  fireVaultSwap,
  __getResettableHandlerNames,
  __resetVaultLifecycleForTests,
} from '@renderer/core/vaultLifecycle';

/**
 * Phase 6.1.R2 — `vaultSwapResettable` helper.
 *
 * Sugar over `onVaultSwap('pre-swap', ...)` that mirrors each
 * registration in a queryable set so a CI gate (or a unit test) can
 * confirm a specific module-state owner registered through this entry
 * point, not just any swap handler.
 */

describe('Phase 6.1.R2 — vaultSwapResettable', () => {
  beforeEach(() => {
    __resetVaultLifecycleForTests();
  });
  afterEach(() => {
    __resetVaultLifecycleForTests();
  });

  it('fires the reset function on pre-swap', async () => {
    let fired = 0;
    vaultSwapResettable('test.module-state', () => {
      fired++;
    });
    await fireVaultSwap({
      phase: 'pre-swap',
      previousVault: '/a',
      nextVault: '/b',
      saveOutgoing: false,
    });
    expect(fired).toBe(1);
  });

  it('registers the name in the queryable set; unsubscribe removes it', () => {
    let fired = 0;
    const unsub = vaultSwapResettable('test.tracked', () => {
      fired++;
    });
    expect(__getResettableHandlerNames().has('test.tracked')).toBe(true);
    unsub();
    expect(__getResettableHandlerNames().has('test.tracked')).toBe(false);
    expect(fired).toBe(0);
  });

  it('coexists with plain onVaultSwap subscribers (both fire on swap)', async () => {
    const order: string[] = [];
    onVaultSwap('pre-swap', 'plain', () => {
      order.push('plain');
    });
    vaultSwapResettable('resettable', () => {
      order.push('resettable');
    });
    await fireVaultSwap({
      phase: 'pre-swap',
      previousVault: null,
      nextVault: '/v',
      saveOutgoing: false,
    });
    expect(order).toEqual(['plain', 'resettable']);
  });
});
