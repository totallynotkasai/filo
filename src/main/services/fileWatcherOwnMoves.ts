import { vaultPath, type VaultPath } from '../../shared/vaultPath';
import type { ReconcileEntry } from './fileWatcherWalk';

/**
 * Filo's own moves as the reconcile walk records them: a rename or move, and
 * a move into Filo's trash and back.
 *
 * The walk diffs each pass against the last. Its suppression windows hide an
 * own move for a few seconds, but a walk after that would find the old paths
 * gone and the new ones new, and report every file of a moved folder as moved
 * by another program: one rename cascade per file, which for a big folder
 * keeps the rename queue busy for a minute. Moving the records with the files
 * when the move succeeds keeps the next walk quiet about it, while a move by
 * another program, which never comes through here, is still reported.
 */

export type WalkSnapshot = Map<string, ReconcileEntry>;

/** The records of a moved item, keyed by path relative to it ('' for a file itself). */
export type MovedRecords = Map<string, ReconcileEntry>;

/** The watcher's path-keyed caches that follow a move. */
export interface WalkPathCaches {
  knownDirs: Set<VaultPath>;
  lastKnownSizes: Map<VaultPath, number>;
  lastKnownHashes: Map<VaultPath, string>;
  /** Whether each path held a file when last seen. */
  presence: Map<VaultPath, boolean>;
}

/**
 * `path` relative to `rel` when it is `rel` or inside it ('' for `rel`
 * itself), else null. Compared case-folded; the suffix keeps its own spelling.
 */
function suffixUnder(path: string, rel: string): string | null {
  const key = vaultPath(path);
  const base = vaultPath(rel);
  if (!base) return null;
  if (key === base) return '';
  if (!key.startsWith(`${base}/`)) return null;
  // By segments, not characters: a case fold may change a name's length.
  return path.split('/').slice(base.split('/').length).join('/');
}

function joinRel(rel: string, suffix: string): string {
  return suffix ? `${rel}/${suffix}` : rel;
}

/** Removes and returns the records at or under `rel`. */
export function takeRecords(snapshot: WalkSnapshot, rel: string): MovedRecords {
  const taken: MovedRecords = new Map();
  for (const [path, entry] of [...snapshot]) {
    const suffix = suffixUnder(path, rel);
    if (suffix === null) continue;
    snapshot.delete(path);
    taken.set(suffix, entry);
  }
  return taken;
}

/**
 * Puts `records` back under `rel`. A path the snapshot already records (a walk
 * that ran after the item came back) keeps its own, newer record.
 */
export function putRecords(snapshot: WalkSnapshot, rel: string, records: MovedRecords): void {
  for (const [suffix, entry] of records) {
    const path = joinRel(rel, suffix);
    if (!snapshot.has(path)) snapshot.set(path, entry);
  }
}

/** Moves the records at or under `oldRel` to `newRel`. */
export function moveRecords(snapshot: WalkSnapshot, oldRel: string, newRel: string): void {
  putRecords(snapshot, newRel, takeRecords(snapshot, oldRel));
}

/**
 * Moves the entries of a path-keyed cache at or under `oldRel` to `newRel`;
 * an entry `carry` turns down is dropped instead.
 */
export function rekeyUnder<T>(map: Map<VaultPath, T>, oldRel: string, newRel: string, carry: (value: T) => boolean = () => true): void {
  const base = vaultPath(oldRel);
  if (!base) return;
  for (const [key, value] of [...map]) {
    if (key !== base && !key.startsWith(`${base}/`)) continue;
    map.delete(key);
    if (carry(value)) map.set(vaultPath(newRel + key.slice(base.length)), value);
  }
}

/**
 * Moves the watcher's size, hash and folder caches with a move, so a later
 * rename of a moved file still pairs.
 *
 * A path last seen gone says nothing about the new place. When the files of a
 * folder were already followed one by one (a sync client reports each), their
 * old paths read gone and their new ones present; carrying "gone" over would
 * make a later rename onto one of them look like a move onto a free name, not
 * the replace it is.
 */
export function moveCaches(caches: WalkPathCaches, oldRel: string, newRel: string): void {
  const base = vaultPath(oldRel);
  rekeyUnder(caches.lastKnownSizes, oldRel, newRel);
  rekeyUnder(caches.lastKnownHashes, oldRel, newRel);
  rekeyUnder(caches.presence, oldRel, newRel, (present) => present);
  for (const key of [...caches.knownDirs]) {
    if (key !== base && !key.startsWith(`${base}/`)) continue;
    caches.knownDirs.delete(key);
    caches.knownDirs.add(vaultPath(newRel + key.slice(base.length)));
  }
}

/** How many trashed items' records are kept for their restore; the oldest go first. */
const MAX_TRASHED_RECORDS = 64;

/**
 * Records of items Filo moved into its trash, by trash id, until they are
 * restored. A restore without them (the list overflowed, or Filo restarted)
 * is reported by the next walk as new files, as before.
 */
export class TrashedRecords {
  private readonly byId = new Map<string, MovedRecords>();

  keep(trashId: string, records: MovedRecords): void {
    if (records.size === 0) return;
    this.byId.set(trashId, records);
    while (this.byId.size > MAX_TRASHED_RECORDS) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
  }

  take(trashId: string): MovedRecords | undefined {
    const records = this.byId.get(trashId);
    this.byId.delete(trashId);
    return records;
  }

  clear(): void {
    this.byId.clear();
  }
}

/** A move as the walk replays it: how it changes a record, and where the moved item now is. */
interface ReplayedMove {
  apply: (snapshot: WalkSnapshot) => void;
  /** The item's path after the move; absent for a move out of the walked vault. */
  to?: string;
}

/**
 * Filo's own moves as they meet the walk. A walk that runs while a move is
 * out may read the folder before the move, after it, or its parent before and
 * its contents after (seeing neither), and may finish before the move is
 * noted. So it waits for every move in progress before it records what it
 * saw, applies to that the moves made meanwhile, and takes a moved file it
 * missed from the record, which the move already updated.
 */
export class OwnMoves {
  private readonly inProgress = new Set<Promise<void>>();
  private duringWalk: ReplayedMove[] = [];
  private walking = false;
  readonly trashed = new TrashedRecords();

  /** A move starts; call the returned function once it is done (after noting it, if it succeeded). */
  begin(): () => void {
    let done!: () => void;
    const move = new Promise<void>((resolve) => { done = resolve; });
    this.inProgress.add(move);
    return () => {
      this.inProgress.delete(move);
      done();
    };
  }

  /** Applies a move (ending at `to`) to the walk's record, and to the walk now running. */
  record(snapshot: WalkSnapshot | null, apply: (snapshot: WalkSnapshot) => void, to?: string): void {
    if (snapshot) apply(snapshot);
    if (this.walking) this.duringWalk.push({ apply, to });
  }

  walkStarted(): void {
    this.walking = true;
    this.duringWalk = [];
  }

  /**
   * Waits out the moves in progress, then brings what the walk saw (`current`)
   * in line with them, using `record()`: the walk's record, which the moves
   * already updated.
   */
  async settleInto(current: WalkSnapshot, record: () => WalkSnapshot | null): Promise<void> {
    while (this.inProgress.size > 0) await Promise.all([...this.inProgress]);
    const moves = this.duringWalk.splice(0);
    for (const move of moves) move.apply(current);
    const known = record();
    if (!known) return;
    for (const { to } of moves) {
      if (to === undefined) continue;
      for (const [path, entry] of known) {
        if (!current.has(path) && suffixUnder(path, to) !== null) current.set(path, entry);
      }
    }
  }

  walkEnded(): void {
    this.walking = false;
    this.duringWalk = [];
  }

  clear(): void {
    this.walkEnded();
    this.trashed.clear();
  }
}
