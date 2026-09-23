import { describe, it, expect, vi } from 'vitest';
import {
  setDefaultScopeFactory,
  setActiveScope,
  getActiveScope,
  resetActiveScope,
  isActiveScope,
  type BoardScope,
} from '@renderer/lib/boards/boardScope.svelte';

/**
 * Audit-7 L18 — `boardScope.activeScopeRef`/`activeScopeRaw` are only ever
 * written by a mounted `PaneView`'s `setActiveScope`. On vault swap every
 * PaneView unmounts but those refs lingered, so the global facades resolved to
 * the OUTGOING vault's dead scope until the new vault's first PaneView `$effect`
 * re-ran. `resetActiveScope()` (registered as a `pre-swap` reset) nulls them so
 * the next `getActiveScope()` lazily rebuilds a fresh default scope.
 */
function fakeScope(): BoardScope {
  // Structural stand-in — the active-scope plumbing only swaps references.
  return { board: {}, canvas: {}, selection: {}, spatial: {} } as unknown as BoardScope;
}

describe('Audit-7 L18 — boardScope active-scope reset', () => {
  it('resetActiveScope drops the prior vault scope; getActiveScope rebuilds fresh', () => {
    const make = vi.fn(fakeScope);
    setDefaultScopeFactory(make);

    const outgoing = fakeScope();
    setActiveScope(outgoing);
    expect(isActiveScope(outgoing)).toBe(true);

    make.mockClear();
    resetActiveScope();

    // The dead scope is no longer active, even before any rebuild.
    expect(isActiveScope(outgoing)).toBe(false);

    // Next access lazily rebuilds via the factory — NOT the outgoing scope.
    const fresh = getActiveScope();
    expect(make).toHaveBeenCalledTimes(1);
    expect(fresh).toBeDefined();
    expect(isActiveScope(outgoing)).toBe(false);
  });
});
