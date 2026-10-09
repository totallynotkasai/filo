import { vaultPath, type VaultPath } from '../../shared/vaultPath';
import { rekeyUnder } from './fileWatcherOwnMoves';

/**
 * Where a note the walk finds gone may have gone, when the live watcher has
 * already seen its new path.
 *
 * Windows reports a folder another program renamed by the two folder names
 * alone, and Node's watcher on Linux reports every file of a folder that
 * appears as new. Either way the new path of a moved note can reach a notify
 * pass before the walk finds its old path gone: an edit to it, or the new
 * file itself. The presence map then says the new path held a file before the
 * walk's batch, and the pairing refuses a move onto a known file (a file
 * renamed over another is that file changed). So the watcher remembers which
 * paths **arrived**: an event first saw the path holding a file where none was
 * known, and nothing paired with it. A note the walk finds gone may pair with a
 * same-named arrival that came after the note was last seen; the pairing's
 * usual checks (the bytes, or a note moved and changed) then decide.
 *
 * A note is last seen by the walk that recorded it, Filo's own write or an
 * event that found it there. A path a walk has recorded twice is no arrival
 * any more, nor one Filo wrote, and one that goes is forgotten.
 */
export class Arrivals {
  /** When an event first saw each path holding a file where none was known. */
  private readonly arrivedAt = new Map<VaultPath, number>();
  /** The last time an event or Filo's own write saw each path holding a file. */
  private readonly seenAt = new Map<VaultPath, number>();
  /** Notes the walk found gone, with the time of the record it last had of each, until their events are sent. */
  private readonly walkedGoneAt = new Map<VaultPath, number>();

  /** An event found `key` holding a file; `known` says whether the presence map already had it there. */
  sawPresent(key: VaultPath, known: boolean, at: number): void {
    this.seenAt.set(key, at);
    if (!known && !this.arrivedAt.has(key)) this.arrivedAt.set(key, at);
  }

  /** An event found `key` gone. */
  sawGone(key: VaultPath): void {
    this.arrivedAt.delete(key);
    this.seenAt.delete(key);
  }

  /**
   * The walk found `key` new. It arrived no later than the walk, so a note the
   * same walk recorded can't have moved to it unseen.
   */
  walkFoundNew(key: VaultPath, recordedAt: number): void {
    if (!this.arrivedAt.has(key)) this.arrivedAt.set(key, recordedAt);
  }

  /** The walk found the note `key` gone; `recordedAt` is the time of its last record. */
  walkFoundGone(key: VaultPath, recordedAt: number): void {
    this.walkedGoneAt.set(key, recordedAt);
  }

  /** A walk recorded `key` again: it was there at the walk before, so it is no arrival. */
  walked(key: VaultPath, recordedAt: number): void {
    this.arrivedAt.delete(key);
    // A later sighting (an event during the walk) still counts.
    if ((this.seenAt.get(key) ?? -Infinity) <= recordedAt) this.seenAt.delete(key);
  }

  /** Filo wrote, or brought back, `key`. */
  written(key: VaultPath, at: number): void {
    this.arrivedAt.delete(key);
    this.seenAt.set(key, at);
  }

  /** The event for `key` went out (or was paired): the walk's record of it is no longer asked about. */
  sent(key: VaultPath): void {
    this.walkedGoneAt.delete(key);
  }

  /** `oldKey` was paired with `newKey` as a move. */
  paired(oldKey: VaultPath, newKey: VaultPath): void {
    this.walkedGoneAt.delete(oldKey);
    this.arrivedAt.delete(oldKey);
    this.arrivedAt.delete(newKey);
  }

  /** Everything at or under `rel` went into Filo's trash. */
  forgetUnder(rel: string): void {
    rekeyUnder(this.arrivedAt, rel, rel, () => false);
    rekeyUnder(this.seenAt, rel, rel, () => false);
  }

  /** `oldRel` (a file, or a folder with everything in it) moved to `newRel`: its arrivals and sightings go with it. */
  move(oldRel: string, newRel: string): void {
    rekeyUnder(this.arrivedAt, oldRel, newRel);
    rekeyUnder(this.seenAt, oldRel, newRel);
  }

  /**
   * Whether `present` arrived after the note `missing`, which the walk found
   * gone, was last seen: it may then be that note, moved.
   */
  arrivedSinceLastSeen(present: string, missing: string): boolean {
    const missingKey = vaultPath(missing);
    const recordedAt = this.walkedGoneAt.get(missingKey);
    const arrivedAt = this.arrivedAt.get(vaultPath(present));
    if (recordedAt === undefined || arrivedAt === undefined) return false;
    return Math.max(recordedAt, this.seenAt.get(missingKey) ?? -Infinity) < arrivedAt;
  }

  /** Whether any arrival is waiting (the walk skips its per-file bookkeeping when none is). */
  any(): boolean {
    return this.arrivedAt.size > 0 || this.seenAt.size > 0;
  }

  clear(): void {
    this.arrivedAt.clear();
    this.seenAt.clear();
    this.walkedGoneAt.clear();
  }
}
