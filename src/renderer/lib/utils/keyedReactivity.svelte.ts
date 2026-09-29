import { SvelteMap } from 'svelte/reactivity';

/**
 * Per-key reactivity for path-keyed stores.
 *
 * `SvelteMap.get(key)` tracks that key alone when the key is present, but a
 * read of a key that ISN'T present tracks the whole map's version, so adding
 * any entry re-runs every reader that looked up a missing one. With a board
 * of 300 cards each asking "is this note open?", opening one note re-derived
 * all 300 cards; opening them one by one was quadratic.
 *
 * `KeyedVersions` gives each key its own counter. A reader calls `track(key)`
 * and depends on that key only; a writer calls `bump(key)`. It is a
 * `SvelteMap<K, number>` whose keys are put into the underlying `Map`
 * without a reactive write (`Map.prototype.set`), which is safe inside a
 * `$derived`: `SvelteMap.get` then finds the key present and creates that
 * key's own source, which the reading derived tracks. `keyedReactivity.test.ts`
 * pins this against Svelte upgrades.
 *
 * Every reader also tracks one shared epoch. Telling a source's readers walks
 * everything downstream of them, so bumping 300 keys that feed one list
 * walks that list 300 times; `bumpAll` tells every reader in one walk.
 */
class Epoch {
  v = $state(0);
}

export class KeyedVersions<K> {
  readonly #versions = new SvelteMap<K, number>();
  readonly #epoch = new Epoch();

  /** Makes the current reaction depend on `key`'s changes (and `bumpAll`). */
  track(key: K): void {
    if (!Map.prototype.has.call(this.#versions, key)) Map.prototype.set.call(this.#versions, key, 0);
    this.#versions.get(key);
    void this.#epoch.v;
  }

  /** Re-runs the readers of `key`. A key nobody has read has no readers to tell. */
  bump(key: K): void {
    const n = Map.prototype.get.call(this.#versions, key) as number | undefined;
    if (n !== undefined) this.#versions.set(key, n + 1);
  }

  /** Re-runs every reader, in one pass (a batch of many keys). */
  bumpAll(): void {
    this.#epoch.v += 1;
  }

  /** Re-runs every reader and forgets the keys (a vault swap). */
  reset(): void {
    this.#versions.clear();
  }
}

/**
 * A `SvelteMap` whose lookups of a missing key track that key alone (see
 * `KeyedVersions`), so adding an entry re-runs only the readers of that key.
 * Iteration and `size` still track the whole map.
 */
export class KeyedSvelteMap<K, V> extends SvelteMap<K, V> {
  readonly #absent = new KeyedVersions<K>();

  override get(key: K): V | undefined {
    if (!Map.prototype.has.call(this, key)) {
      this.#absent.track(key);
      return undefined;
    }
    return super.get(key);
  }

  override has(key: K): boolean {
    if (!Map.prototype.has.call(this, key)) {
      this.#absent.track(key);
      return false;
    }
    return super.has(key);
  }

  override set(key: K, value: V): this {
    const added = !Map.prototype.has.call(this, key);
    super.set(key, value);
    if (added) this.#absent.bump(key);
    return this;
  }
}
