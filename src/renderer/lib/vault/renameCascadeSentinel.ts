/**
 * Rename-cascade recovery sentinel — survives a crash / partial-failure
 * between `vault:rename` and the post-rename `.board.json` flush.
 *
 * `vaultFolderOps.rename` runs four ordered steps:
 *
 *   1. Run the in-memory propagateRename cascade (cache mutated to the
 *      new path).
 *   2. Call `vault:rename` IPC (disk file moves).
 *   3. Flush every dirty `.board.json` so the new path lands on disk.
 *   4. Refresh the vault tree.
 *
 * If step 2 succeeds but step 3 partially fails, the user gets a toast —
 * but mid-session the in-memory cache says "new path" while one or more
 * `.board.json` files on disk still hold the old path. The next session
 * load would read those stale references and surface a broken-ref badge.
 *
 * This sentinel records the rename intent BEFORE step 2. On vault open,
 * if any sentinel entry remains, the recovery modal offers to retry the
 * cascade against the freshly-loaded cache. The retry is idempotent: a
 * board that already flushed simply has no propagateRename matches left.
 *
 * An entry is path rewrites only: old path, new path, and which boards to
 * re-save. Everything a retry repairs is keyed by path — board file refs,
 * the path-keyed stores, and media tags in `.filo/tags.json` — so nothing
 * else needs recording. A rename never writes the note itself (its title
 * and tags are in its frontmatter and move with the bytes).
 *
 * A file that doesn't parse as this shape reads as `unreadable`: it is kept
 * on disk and surfaced to the user, never overwritten or replayed.
 *
 * Mirrors the tag-rewrite-sweep pattern. Lives in `lib/vault/`
 * because it's pure I/O orchestration (no UI). The store layer
 * (vaultRecovery) reads the sentinel on vault open and wires the retry
 * handlers.
 */

import { reportError } from '../utils/errorBus';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { invokeOk } from '../utils/invokeOk';
import { createId } from '../utils/ids';
import { onVaultSwap } from '../../core/vaultLifecycle';
import { ownSentinelPath } from './machineIdentity';
import { readOwnSentinel, clearOwnSentinel } from './machineSentinels';
import { normalizeVaultRelative } from '../../../shared/vaultPath';

/**
 * PER MACHINE (`.filo/rename-cascade-pending.<machineId>.json`):
 * another machine must never replay (or clear) this machine's half-finished
 * rename cascade.
 */
const ownRenameCascadePath = (): string => ownSentinelPath('rename-cascade');

export interface RenameCascadeEntry {
  /** Stable nanoid for this rename intent — used as the dedupe key. */
  id: string;
  /** ms-since-epoch when the sentinel entry was laid down. */
  timestamp: number;
  /** Vault-relative path the rename moved FROM. */
  oldPath: string;
  /** Vault-relative path the rename moved TO. */
  newPath: string;
  /**
   * Board IDs that propagateRename touched in the in-memory cascade —
   * the set of boards whose `.board.json` should reflect the new path.
   * Used by the retry path to scope its post-cascade flush.
   */
  affectedBoardIds: string[];
  /**
   * Subset of `affectedBoardIds` whose `.board.json` write was already
   * known to have failed when the sentinel was written. Populated by
   * `markRenameCascadeFlushFailed`. The retry uses this to surface the
   * specific files the user needs to know about.
   */
  failedBoardIds?: string[];
}

interface SentinelFile {
  entries: RenameCascadeEntry[];
}

export interface ReadResult {
  /** Present when the sentinel was found and parsed successfully. */
  entries?: RenameCascadeEntry[];
  /**
   * Set when the sentinel was found but unreadable / unparseable. Lets the
   * caller distinguish "no recovery needed" (clean steady state) from
   * "we know something went wrong but can't tell what" (recovery UI should
   * still surface a toast).
   */
  unreadable?: boolean;
}

/**
 * Mutex — serialises every read/write against the sentinel. Without this,
 * a fast double-rename (user fires a second sidebar rename while the first
 * one is still settling) would interleave the read/write halves of two
 * append() calls and lose one of the entries.
 */
let lastOp: Promise<unknown> = Promise.resolve();

function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const next = lastOp.then(fn, fn);
  lastOp = next.catch(() => undefined);
  return next;
}

async function readSentinelInternal(vaultRoot: string): Promise<ReadResult> {
  if (!vaultRoot) return {};
  let content: string;
  try {
    // ENOENT is the steady-state "no sentinel" case and resolves to `{}`;
    // any other failure resolves to `{ unreadable: true }` so recovery UI
    // still surfaces.
    const result = await readOwnSentinel(vaultRoot, 'rename-cascade');
    content = result.content;
  } catch (err) {
    if (err instanceof IpcEnvelopeError) {
      if (err.code === 'ENOENT') return {};
      return { unreadable: true };
    }
    reportError(
      'renameCascadeSentinel.read',
      err,
      "Couldn't read the rename-cascade sentinel — Filo can't verify the previous rename completed",
    );
    return { unreadable: true };
  }
  // A present-but-empty file is a partial write: a crash created the
  // sentinel but never filled it. Surface it as `unreadable` rather than
  // treating it as clean (same rule as a zero-byte `.dirty`).
  if (!content) return { unreadable: true };
  try {
    const parsed = JSON.parse(content) as Partial<SentinelFile>;
    if (!Array.isArray(parsed.entries)) return { unreadable: true };
    const entries: RenameCascadeEntry[] = [];
    for (const raw of parsed.entries as unknown[]) {
      if (!raw || typeof raw !== 'object') return { unreadable: true };
      const e = raw as Partial<RenameCascadeEntry>;
      if (
        typeof e.id !== 'string' ||
        typeof e.timestamp !== 'number' ||
        typeof e.oldPath !== 'string' ||
        typeof e.newPath !== 'string' ||
        !Array.isArray(e.affectedBoardIds) ||
        !e.affectedBoardIds.every((b) => typeof b === 'string')
      ) {
        return { unreadable: true };
      }
      entries.push({
        id: e.id,
        timestamp: e.timestamp,
        oldPath: e.oldPath,
        newPath: e.newPath,
        affectedBoardIds: e.affectedBoardIds,
        failedBoardIds: Array.isArray(e.failedBoardIds)
          ? e.failedBoardIds.filter((b) => typeof b === 'string')
          : undefined,
      });
    }
    return { entries };
  } catch {
    return { unreadable: true };
  }
}

async function writeSentinelInternal(vaultRoot: string, entries: RenameCascadeEntry[]): Promise<void> {
  if (!vaultRoot) return;
  if (entries.length === 0) {
    // Delete the sentinel file entirely when empty so the steady state
    // is "no sentinel on disk" rather than "sentinel with empty array".
    try {
      await clearOwnSentinel(vaultRoot, 'rename-cascade');
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
        return;
      }
      reportError(
        'renameCascadeSentinel.clear',
        err,
        "Could not delete the rename-cascade sentinel — you'll see the retry prompt again on next open",
      );
    }
    return;
  }
  const payload: SentinelFile = { entries };
  // allow-direct-write: the per-machine rename-cascade sentinel is a one-shot
  // crash-recovery file — not a `.md` file, no editor hydrates from it.
  await invokeOk(
    'vault:write-file-text',
    vaultRoot,
    ownRenameCascadePath(),
    JSON.stringify(payload),
  );
}

/**
 * Reads the sentinel if present. Returns `{}` (no `entries`, no
 * `unreadable`) for the steady-state "no sentinel" case so the caller's
 * happy path is a single `if (result.entries?.length)` check.
 */
export function readPendingRenameCascades(vaultRoot: string): Promise<ReadResult> {
  return withMutex(() => readSentinelInternal(vaultRoot));
}

/**
 * Whether a path is, or sits under, a path an unfinished rename names (old or
 * new side). Its attachment tags in `.filo/tags.json` still move with a Retry,
 * so the open-time orphan prune must leave them: attachment tags have no
 * other copy.
 */
export function namedByPendingRename(entries: readonly RenameCascadeEntry[]): (path: string) => boolean {
  const roots = entries
    .flatMap((e) => [e.oldPath, e.newPath])
    .map((p) => normalizeVaultRelative(p).replace(/\/+$/, ''))
    .filter((p) => p.length > 0);
  return (path) => {
    const p = normalizeVaultRelative(path);
    return roots.some((r) => p === r || p.startsWith(`${r}/`));
  };
}

/**
 * Appends a new rename-cascade entry to the sentinel, allocating an id.
 * Awaited so a sentinel-write failure aborts the rename pipeline (we'd
 * rather not move the disk file without a recovery breadcrumb).
 *
 * Refuses to append over an UNREADABLE sentinel: replacing a torn /
 * zero-byte / transiently-locked file would destroy the prior crash
 * breadcrumb and any other in-flight entries. Preserve the file, surface the
 * failure, and throw so the caller's sentinel-failure handling runs.
 *
 * Returns the entry's id so the caller can clear it on full success.
 */
export function writePendingRenameCascade(
  vaultRoot: string,
  partial: Omit<RenameCascadeEntry, 'id' | 'timestamp'>,
): Promise<string> {
  return withMutex(async () => {
    const id = createId();
    const entry: RenameCascadeEntry = {
      id,
      timestamp: Date.now(),
      ...partial,
    };
    const existing = await readSentinelInternal(vaultRoot);
    if (existing.unreadable) {
      const err = new Error(
        'rename-cascade sentinel exists but is unreadable — refusing to overwrite it',
      );
      reportError(
        'renameCascadeSentinel.append',
        err,
        "Couldn't record the rename in this machine's `.filo/rename-cascade-pending.*.json` — the existing file is unreadable and was preserved. Check it manually if a previous rename looks incomplete.",
      );
      throw err;
    }
    const entries = existing.entries ?? [];
    entries.push(entry);
    await writeSentinelInternal(vaultRoot, entries);
    return id;
  });
}

/**
 * Drops the entry with the given id. No-op if the id isn't present
 * (clearing twice is safe). Deletes the sentinel file when no entries
 * remain so the steady state stays clean.
 */
export function clearPendingRenameCascade(vaultRoot: string, id: string): Promise<void> {
  return withMutex(async () => {
    const existing = await readSentinelInternal(vaultRoot);
    if (!existing.entries) return;
    const remaining = existing.entries.filter((e) => e.id !== id);
    if (remaining.length === existing.entries.length) return;
    await writeSentinelInternal(vaultRoot, remaining);
  });
}

/**
 * Records the subset of affectedBoardIds whose `.board.json` flush
 * failed. Lets the recovery modal surface exactly which files the user
 * still needs to worry about.
 */
export function markRenameCascadeFlushFailed(
  vaultRoot: string,
  id: string,
  failedBoardIds: string[],
): Promise<void> {
  return withMutex(async () => {
    const existing = await readSentinelInternal(vaultRoot);
    if (!existing.entries) return;
    let mutated = false;
    const next = existing.entries.map((e) => {
      if (e.id !== id) return e;
      mutated = true;
      return { ...e, failedBoardIds };
    });
    if (!mutated) return;
    await writeSentinelInternal(vaultRoot, next);
  });
}

/** Test-only — drops the in-memory mutex chain. Production never needs this. */
export function __resetRenameCascadeSentinelForTests(): void {
  lastOp = Promise.resolve();
}

// Vault-swap reset: drop the mutex chain so the new vault's first sentinel op
// isn't queued behind ops targeting the outgoing vault.
onVaultSwap('pre-swap', 'renameCascadeSentinel', () => {
  lastOp = Promise.resolve();
});
