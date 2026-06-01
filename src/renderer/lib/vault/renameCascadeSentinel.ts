/**
 * Rename-cascade recovery sentinel — survives a crash / partial-failure
 * between `vault:rename` and the post-rename `.board.json` flush.
 *
 * Sprint 35.3. `vaultFolderOps.rename` runs four ordered steps:
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
 * Mirrors the Phase 9 tag-rewrite-sweep pattern. Lives in `lib/vault/`
 * because it's pure I/O orchestration (no UI). The store layer
 * (vaultRecovery) reads the sentinel on vault open and wires the retry
 * handlers.
 */

import { reportError } from '../utils/errorBus';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { invokeOk } from '../utils/invokeOk';
import { createId } from '../utils/ids';
import { onVaultSwap } from '../../core/vaultLifecycle';

const RENAME_CASCADE_SENTINEL_PATH = '.filo/rename-cascade-pending.json';

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
  /**
   * Phase 4 / E5 — true when the rename also touched the `.filo/tags.json`
   * tag-membership sink (i.e. a file/folder rename, which moves
   * `fileTags[oldPath]` → `fileTags[newPath]`). Recovery re-asserts the tag
   * rename (idempotently) alongside the board cascade so a crash in the
   * window between the disk rename and the synchronous tag flush (F3) can't
   * leave `tags.json` keyed by the OLD path while every `.board.json`
   * already points at the new one — the silent tag-membership loss F3
   * point-fixed and E5 makes fully recoverable.
   *
   * Optional + defaults to `false` on read so sentinels written by an older
   * build (board-only) still parse; their recovery simply skips the tag
   * re-assert, matching pre-E5 behaviour.
   *
   * Note on the "frontmatter" sink: a file rename does NOT write the renamed
   * file's frontmatter — the OS moves the bytes as-is and frontmatter
   * encodes no self-path, so there is no frontmatter sink to record for a
   * rename. (Tag *renames*, a different operation, rewrite frontmatter via
   * the separate `tagRewriteSentinel`.)
   */
  tagsAffected?: boolean;
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
    // Phase 37 / 37.6 — canonical two-arg form.
    // Phase 1 (CONSOLIDATION_PLAN) — ENOENT is the steady-state "no
    // sentinel" case and resolves to `{}`; any other failure resolves
    // to `{ unreadable: true }` so recovery UI still surfaces.
    const result = await invokeOk('vault:read-file-text', vaultRoot, RENAME_CASCADE_SENTINEL_PATH);
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
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as Partial<SentinelFile>;
    if (!Array.isArray(parsed.entries)) return { unreadable: true };
    const entries: RenameCascadeEntry[] = [];
    for (const raw of parsed.entries) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof (raw as RenameCascadeEntry).id !== 'string' ||
        typeof (raw as RenameCascadeEntry).timestamp !== 'number' ||
        typeof (raw as RenameCascadeEntry).oldPath !== 'string' ||
        typeof (raw as RenameCascadeEntry).newPath !== 'string' ||
        !Array.isArray((raw as RenameCascadeEntry).affectedBoardIds) ||
        !(raw as RenameCascadeEntry).affectedBoardIds.every((b) => typeof b === 'string')
      ) {
        return { unreadable: true };
      }
      entries.push({
        id: (raw as RenameCascadeEntry).id,
        timestamp: (raw as RenameCascadeEntry).timestamp,
        oldPath: (raw as RenameCascadeEntry).oldPath,
        newPath: (raw as RenameCascadeEntry).newPath,
        affectedBoardIds: (raw as RenameCascadeEntry).affectedBoardIds,
        failedBoardIds: Array.isArray((raw as RenameCascadeEntry).failedBoardIds)
          ? (raw as RenameCascadeEntry).failedBoardIds!.filter((b) => typeof b === 'string')
          : undefined,
        // E5 — defaults to false for board-only sentinels written before this field existed.
        tagsAffected: (raw as RenameCascadeEntry).tagsAffected === true,
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
      const fullPath = `${vaultRoot.replace(/[\\/]$/, '')}/${RENAME_CASCADE_SENTINEL_PATH}`;
      try {
        await invokeOk('vault:delete', vaultRoot, fullPath);
      } catch (err) {
        if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') return;
        throw err;
      }
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
  // allow-direct-write: `.filo/rename-cascade-pending.json` is a one-shot
  // crash-recovery sentinel — not a `.md` file, no editor hydrates from it.
  await invokeOk(
    'vault:write-file-text',
    vaultRoot,
    RENAME_CASCADE_SENTINEL_PATH,
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
 * Appends a new rename-cascade entry to the sentinel, allocating an id.
 * Awaited so a sentinel-write failure aborts the rename pipeline (we'd
 * rather not move the disk file without a recovery breadcrumb).
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

// Phase 3 (IMPL_PLAN 2026-05-25) — vault-swap reset. The mutex chain
// head holds promises tethered to the outgoing vault's sentinel path. A
// straggling append() / clear() enqueued just before swap would
// otherwise drag the new vault's first sentinel op behind a chain whose
// IPCs target a vault root that's no longer active.
onVaultSwap('pre-swap', 'renameCascadeSentinel', () => {
  lastOp = Promise.resolve();
});
