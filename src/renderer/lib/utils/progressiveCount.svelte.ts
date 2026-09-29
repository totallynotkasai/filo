import { untrack } from 'svelte';

/**
 * How many rows of a long list to render: the first `initial` at once, then
 * `step` more in each idle period until all are shown (`shown` becomes
 * `Infinity`, so rows added later show at once).
 *
 * Expanding a sidebar folder of 2,000 notes mounted every row in one flush
 * (about half a second); the first rows now paint straight away and the rest
 * follow without holding up input. A list no longer than `initial` renders
 * whole, as before.
 */
export class ProgressiveCount {
  shown = $state(0);
  #handle: ReturnType<typeof setTimeout> | number | null = null;

  constructor(
    private readonly total: () => number,
    private readonly initial = 150,
    private readonly step = 150,
  ) {
    this.shown = initial;
  }

  /** Whether every row is rendered. */
  get complete(): boolean {
    return this.shown === Infinity;
  }

  /** Starts from the first rows again (the list was just shown). */
  start(): void {
    this.stop();
    this.shown = this.initial;
    this.#next();
  }

  /** Stops growing (the list was hidden or unmounted). */
  stop(): void {
    if (this.#handle === null) return;
    if (typeof cancelIdleCallback === 'function' && typeof this.#handle === 'number') cancelIdleCallback(this.#handle);
    else clearTimeout(this.#handle);
    this.#handle = null;
  }

  #next(): void {
    if (this.shown >= untrack(this.total)) {
      this.shown = Infinity;
      return;
    }
    const grow = (): void => {
      this.#handle = null;
      this.shown += this.step;
      this.#next();
    };
    this.#handle = typeof requestIdleCallback === 'function'
      ? requestIdleCallback(grow, { timeout: 500 })
      : setTimeout(grow, 16);
  }
}
