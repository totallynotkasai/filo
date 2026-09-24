/**
 * After a vault swap resets the active pane scope, the first read through a
 * global facade (`boardStore`, `canvasStore`, …) often happens inside a
 * `$derived` (e.g. the mind map's background pattern reads board settings).
 * Building the default scope there must not write `$state`, or Svelte throws
 * `state_unsafe_mutation` and the board fails to render.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getActiveScope,
  resetActiveScope,
  setActiveScope,
  isActiveScope,
  type BoardScope,
} from '@renderer/lib/boards/boardScope.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { readInDerived } from './helpers/readInDerived.svelte';

afterEach(() => {
  resetActiveScope();
});

describe('default board scope built lazily inside a $derived', () => {
  it('reading a facade in a $derived after a reset does not throw', () => {
    resetActiveScope();
    expect(() => readInDerived(() => boardStore.current)).not.toThrow();
  });

  it('the lazily built default is reused and is the active scope', () => {
    resetActiveScope();
    const first = readInDerived(() => getActiveScope());
    expect(getActiveScope()).toBe(first);
    expect(isActiveScope(first)).toBe(true);
  });

  it('a pane that becomes active replaces the default', () => {
    resetActiveScope();
    const fallback = getActiveScope();
    const pane = { ...fallback } as BoardScope;
    setActiveScope(pane);
    expect(isActiveScope(pane)).toBe(true);
    expect(isActiveScope(fallback)).toBe(false);
  });
});
