import { flushSync } from 'svelte';

/**
 * Keeps `fn` live in a `$derived`, as a mounted component would, and records
 * each value it settles on. Shows whether a change re-runs it.
 */
export function watchDerived<T>(fn: () => T): { values: T[]; stop(): void } {
  const values: T[] = [];
  const stop = $effect.root(() => {
    const value = $derived.by(fn);
    $effect(() => {
      values.push(value);
    });
  });
  flushSync();
  return { values, stop };
}
