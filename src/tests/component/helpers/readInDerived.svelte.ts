/**
 * Evaluate `fn` the way a component's `$derived` / template expression does,
 * so a test can prove a read path doesn't write `$state` (Svelte throws
 * `state_unsafe_mutation` when it does).
 */
export function readInDerived<T>(fn: () => T): T {
  let out: T | undefined;
  const cleanup = $effect.root(() => {
    const value = $derived.by(fn);
    const read = (): T => value;
    out = read();
  });
  cleanup();
  return out as T;
}
