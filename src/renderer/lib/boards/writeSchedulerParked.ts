/**
 * A scheduler's PARKED writes, per key: writes neither pending (no timer
 * armed any more) nor in flight (not sent yet). Two kinds park:
 *  - a debounce timer that fires while a write for its key is still in
 *    flight, and waits behind it (`drainPriorInFlight`) so the newest lands
 *    last;
 *  - an entry a full save (`flushAll`) has captured and not yet sent, since
 *    it sends them one after another. A newer schedule of its key takes it
 *    out (`superseded`): its args are older than that schedule's.
 * Each registers here before it waits, and resolves once it has fired (its
 * in-flight entry registered, synchronously) or dropped out, so `flush` /
 * `flushAll` await it and `hasWork` counts it. An entry carries the
 * schedule-time sentinel info and a `cancelled` flag, so `cancel(key)` can
 * reach it.
 */
import type { VaultPath } from '../../../shared/vaultPath';
import { vaultPath } from '../../../shared/vaultPath';
import type { ParkedEntry } from './writeSchedulerTypes';

/** A new parked entry and the function that resolves its promise. */
export function newParkedEntry(vaultRoot: string | undefined, path: string | undefined): { entry: ParkedEntry; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { entry: { promise, vaultRoot, path, cancelled: false, superseded: false }, resolve };
}

export class ParkedWrites {
  private readonly byKey = new Map<string, Set<ParkedEntry>>();

  add(key: string, entry: ParkedEntry): void {
    let set = this.byKey.get(key);
    if (!set) this.byKey.set(key, (set = new Set<ParkedEntry>()));
    set.add(entry);
  }

  remove(key: string, entry: ParkedEntry): void {
    const set = this.byKey.get(key);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) this.byKey.delete(key);
  }

  /** `key`'s parked entries (empty when none). */
  of(key: string): ReadonlySet<ParkedEntry> {
    return this.byKey.get(key) ?? new Set<ParkedEntry>();
  }

  any(): boolean {
    for (const set of this.byKey.values()) if (set.size > 0) return true;
    return false;
  }

  /** Every parked entry's promise. */
  promises(): Promise<void>[] {
    const out: Promise<void>[] = [];
    for (const set of this.byKey.values()) for (const p of set) out.push(p.promise);
    return out;
  }

  /** True when an entry not cancelled matches `predicate` (given the schedule-time key and path). */
  matches(predicate: (info: { key: string; path: string | undefined }) => boolean): boolean {
    for (const [key, set] of this.byKey) {
      for (const entry of set) if (!entry.cancelled && predicate({ key, path: entry.path })) return true;
    }
    return false;
  }

  /** True when an entry not cancelled will write `path`. */
  holdsPath(path: VaultPath): boolean {
    return this.matches((info) => !!info.path && vaultPath(info.path) === path);
  }

  clear(): void {
    this.byKey.clear();
  }
}
