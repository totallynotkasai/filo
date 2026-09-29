import { flushSync } from 'svelte';

export interface DerivedProbe<T> {
  /** How many times the derived has run (after flushing pending updates). */
  runs(): number;
  /** Its current value (after flushing pending updates). */
  value(): T;
  stop(): void;
}

/**
 * A `$derived` of `fn`, kept live by an effect, that counts its runs: what a
 * component reading `fn()` in its template would re-run. For reactivity tests.
 */
export function probeDerived<T>(fn: () => T): DerivedProbe<T> {
  let runs = 0;
  let last: T | undefined;
  const stop = $effect.root(() => {
    const d = $derived.by(() => {
      runs++;
      return fn();
    });
    $effect(() => {
      last = d;
    });
  });
  flushSync();
  return {
    runs: () => {
      flushSync();
      return runs;
    },
    value: () => {
      flushSync();
      return last as T;
    },
    stop,
  };
}
