/**
 * The close-drain gate freezes every editor while a close / leave saves, so no
 * keystroke can re-arm a debounce the save never saw. The two ways it can go
 * wrong are both bad: stuck raised (editing frozen for the rest of the
 * session) or lowered too early (a keystroke lands between the save and the
 * unmount and is lost). Each case loads a fresh copy of the module with its
 * own vault-lifecycle registry, so the pre-swap reset runs alone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type GateModule = typeof import('@renderer/lib/editor/closeDrainGate.svelte');
type LifecycleModule = typeof import('@renderer/core/vaultLifecycle');

let gate: GateModule;
let lifecycle: LifecycleModule;

beforeEach(async () => {
  vi.resetModules();
  lifecycle = await import('@renderer/core/vaultLifecycle');
  lifecycle.__resetVaultLifecycleForTests();
  gate = await import('@renderer/lib/editor/closeDrainGate.svelte');
});

function swap(): Promise<void> {
  return lifecycle.fireVaultSwap({ phase: 'pre-swap', previousVault: '/a', nextVault: '/b', saveOutgoing: true });
}

describe('runWithCloseDrain', () => {
  it('raises the gate while the drain runs and lowers it after', async () => {
    expect(gate.closeDrainGate.draining).toBe(false);
    let seen: boolean | null = null;
    const result = await gate.runWithCloseDrain(async () => {
      seen = gate.closeDrainGate.draining;
      return 42;
    });
    expect(seen).toBe(true);
    expect(result).toBe(42);
    expect(gate.closeDrainGate.draining).toBe(false);
  });

  it('lowers the gate when the drain throws, and rethrows', async () => {
    await expect(
      gate.runWithCloseDrain(async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
    expect(gate.closeDrainGate.draining).toBe(false);
  });

  it('keeps the gate up until the outermost of overlapping drains ends', async () => {
    let releaseOuter!: () => void;
    const outer = gate.runWithCloseDrain(() => new Promise<void>((r) => { releaseOuter = r; }));
    await gate.runWithCloseDrain(async () => undefined);
    // The inner drain finished, but the outer is still deciding.
    expect(gate.closeDrainGate.draining).toBe(true);
    releaseOuter();
    await outer;
    expect(gate.closeDrainGate.draining).toBe(false);
  });
});

describe('holdCloseDrainUntilSwap', () => {
  it('raises the gate until released', () => {
    const release = gate.holdCloseDrainUntilSwap();
    expect(gate.closeDrainGate.draining).toBe(true);
    release();
    expect(gate.closeDrainGate.draining).toBe(false);
  });

  it('a second release call does not lower a gate someone else still holds', async () => {
    const release = gate.holdCloseDrainUntilSwap();
    const other = gate.holdCloseDrainUntilSwap();
    release();
    release();
    expect(gate.closeDrainGate.draining).toBe(true);
    other();
    expect(gate.closeDrainGate.draining).toBe(false);
  });

  it('a held gate outlives a tab-close drain that finishes inside it', async () => {
    const release = gate.holdCloseDrainUntilSwap();
    await gate.runWithCloseDrain(async () => undefined);
    expect(gate.closeDrainGate.draining).toBe(true);
    release();
    expect(gate.closeDrainGate.draining).toBe(false);
  });
});

describe('the vault swap', () => {
  it('registers a pre-swap reset', () => {
    expect(lifecycle.__getRegisteredHandlerNames()['pre-swap']).toContain('closeDrainGate');
  });

  it('lowers a gate held for leaving, so the new vault\'s editors are editable', async () => {
    gate.holdCloseDrainUntilSwap();
    gate.holdCloseDrainUntilSwap();
    await swap();
    expect(gate.closeDrainGate.draining).toBe(false);
  });

  it('keeps the gate up until the tabs have unmounted the outgoing editors', async () => {
    let drainingWhileTabsUnmount: boolean | null = null;
    // Registered after the gate's handler on purpose: `runAfter` must still
    // order the gate's reset behind it.
    lifecycle.onVaultSwap('pre-swap', 'tabs', () => {
      drainingWhileTabsUnmount = gate.closeDrainGate.draining;
    });
    gate.holdCloseDrainUntilSwap();
    await swap();
    expect(drainingWhileTabsUnmount).toBe(true);
    expect(gate.closeDrainGate.draining).toBe(false);
  });

  it('a stale release after the swap does not drive the depth negative', async () => {
    const staleRelease = gate.holdCloseDrainUntilSwap();
    await swap();
    staleRelease();
    // A new hold must still raise and a single release must still lower it.
    const release = gate.holdCloseDrainUntilSwap();
    expect(gate.closeDrainGate.draining).toBe(true);
    release();
    expect(gate.closeDrainGate.draining).toBe(false);
  });
});
