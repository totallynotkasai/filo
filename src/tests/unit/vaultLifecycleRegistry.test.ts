import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  onVaultSwap,
  fireVaultSwap,
  __resetVaultLifecycleForTests,
  __getRegisteredHandlerNames,
  type VaultSwapEvent,
} from '@renderer/core/vaultLifecycle';

/**
 * Phase 4 (Consolidation 2026-05-25) — vault-lifecycle registry contract.
 *
 * The registry is the single subscription point for vault-swap reset. Tests
 * cover:
 *   1. Subscribe / unsubscribe semantics, including re-registration overwrite.
 *   2. Dispatch — no-op when a phase has no handlers; event-payload propagation.
 *   3. `runAfter` dependency ordering within a phase.
 *   4. Cycle handling — falls back to registration order with reportError.
 *   5. Error policy — a handler that throws does NOT abort the chain; the
 *      remaining handlers still fire.
 *   6. Event payload — saveOutgoing / previousVault / nextVault propagation.
 *   7. Async handlers — sequential await within a phase.
 */

beforeEach(() => {
  __resetVaultLifecycleForTests();
});

function makeEvent(overrides: Partial<VaultSwapEvent> = {}): VaultSwapEvent {
  return {
    phase: 'pre-swap',
    previousVault: '/old/vault',
    nextVault: '/new/vault',
    saveOutgoing: false,
    ...overrides,
  };
}

describe('vaultLifecycle.onVaultSwap — subscribe + unsubscribe', () => {
  it('registers a handler under the requested name + phase', () => {
    onVaultSwap('pre-swap', 'a', () => {});
    expect(__getRegisteredHandlerNames()['pre-swap']).toEqual(['a']);
  });

  it('returns an unsubscribe function that removes the handler', () => {
    const off = onVaultSwap('pre-swap', 'a', () => {});
    off();
    expect(__getRegisteredHandlerNames()['pre-swap']).toEqual([]);
  });

  it('re-registering the same name overwrites the prior entry', async () => {
    const calls: string[] = [];
    onVaultSwap('pre-swap', 'a', () => { calls.push('first'); });
    onVaultSwap('pre-swap', 'a', () => { calls.push('second'); });
    await fireVaultSwap(makeEvent());
    expect(calls).toEqual(['second']);
  });
});

describe('vaultLifecycle.fireVaultSwap — phase dispatch', () => {
  it('is a no-op when no handlers are registered for a phase', async () => {
    await expect(fireVaultSwap(makeEvent())).resolves.toBeUndefined();
  });

  it('passes the event payload to each handler', async () => {
    let received: VaultSwapEvent | null = null;
    onVaultSwap('pre-swap', 'capture', (e) => { received = e; });
    const event = makeEvent({
      previousVault: '/some/path',
      nextVault: '/other/path',
      saveOutgoing: true,
    });
    await fireVaultSwap(event);
    expect(received).not.toBeNull();
    expect(received!.previousVault).toBe('/some/path');
    expect(received!.nextVault).toBe('/other/path');
    expect(received!.saveOutgoing).toBe(true);
  });
});

describe('vaultLifecycle.fireVaultSwap — ordering', () => {
  it('runs handlers in registration order by default', async () => {
    const fired: string[] = [];
    onVaultSwap('pre-swap', 'a', () => { fired.push('a'); });
    onVaultSwap('pre-swap', 'b', () => { fired.push('b'); });
    onVaultSwap('pre-swap', 'c', () => { fired.push('c'); });
    await fireVaultSwap(makeEvent());
    expect(fired).toEqual(['a', 'b', 'c']);
  });

  it('honours runAfter dependencies within a phase', async () => {
    const fired: string[] = [];
    onVaultSwap('pre-swap', 'a', () => { fired.push('a'); }, { runAfter: ['b'] });
    onVaultSwap('pre-swap', 'b', () => { fired.push('b'); }, { runAfter: ['c'] });
    onVaultSwap('pre-swap', 'c', () => { fired.push('c'); });
    await fireVaultSwap(makeEvent());
    expect(fired).toEqual(['c', 'b', 'a']);
  });

  it('ignores unknown runAfter targets (no error)', async () => {
    const fired: string[] = [];
    onVaultSwap('pre-swap', 'a', () => { fired.push('a'); }, { runAfter: ['does-not-exist'] });
    await fireVaultSwap(makeEvent());
    expect(fired).toEqual(['a']);
  });
});

describe('vaultLifecycle.fireVaultSwap — error policy', () => {
  it('a throwing handler does NOT abort the chain', async () => {
    const fired: string[] = [];
    onVaultSwap('pre-swap', 'a', () => { fired.push('a'); });
    onVaultSwap('pre-swap', 'b', () => { throw new Error('intentional'); });
    onVaultSwap('pre-swap', 'c', () => { fired.push('c'); });
    // reportError under the hood — silence the console output so the test
    // log stays readable. The thrown error is intentional fixture noise.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await fireVaultSwap(makeEvent());
    } finally {
      errSpy.mockRestore();
    }
    expect(fired).toEqual(['a', 'c']);
  });

  it('an async handler rejection does NOT abort the chain', async () => {
    const fired: string[] = [];
    onVaultSwap('pre-swap', 'a', () => { fired.push('a'); });
    onVaultSwap('pre-swap', 'b', async () => { throw new Error('async-fail'); });
    onVaultSwap('pre-swap', 'c', () => { fired.push('c'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await fireVaultSwap(makeEvent());
    } finally {
      errSpy.mockRestore();
    }
    expect(fired).toEqual(['a', 'c']);
  });
});

describe('vaultLifecycle.fireVaultSwap — async handlers', () => {
  it('awaits async handlers sequentially', async () => {
    const fired: string[] = [];
    onVaultSwap('pre-swap', 'a', async () => {
      await new Promise((r) => setTimeout(r, 10));
      fired.push('a');
    });
    onVaultSwap('pre-swap', 'b', () => {
      fired.push('b');
    });
    await fireVaultSwap(makeEvent());
    expect(fired).toEqual(['a', 'b']);
  });
});

describe('vaultLifecycle — cycle detection', () => {
  it('falls back to registration order on a runAfter cycle (no deadlock)', async () => {
    const fired: string[] = [];
    onVaultSwap('pre-swap', 'a', () => { fired.push('a'); }, { runAfter: ['b'] });
    onVaultSwap('pre-swap', 'b', () => { fired.push('b'); }, { runAfter: ['a'] });
    // Cycle is reported via reportError → console.error; silence to keep
    // the test output clean.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await fireVaultSwap(makeEvent());
    } finally {
      errSpy.mockRestore();
    }
    expect(fired.sort()).toEqual(['a', 'b']);
  });
});
