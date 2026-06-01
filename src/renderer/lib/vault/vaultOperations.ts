/**
 * Phase R2 (2026-05-26) — single entry point for every disk-shape change.
 *
 * The audit found four call sites that touched the disk shape without first
 * flushing pending writers:
 *  - `vaultExternalChanges.handleExternalRename` — external rename of `.md`
 *    with a dirty editor → pending markdown write fires after the rename →
 *    ENOENT → silent loss.
 *  - `vaultFolderOps.delete` — in-app folder delete → pending writes inside
 *    the folder fire post-IPC → ENOENT.
 *  - `AppShell.performDeleteSelected` + `TileHeader.performDeleteTile` —
 *    "Delete with files" reads `.md` from disk for the undo snapshot
 *    BEFORE flushing pending edits → undo restores stale content.
 *
 * `withDrainedWrites(op)` enforces the contract by design: every disk-shape
 * change first drains the three writer pipelines, then runs `op`. If any
 * drain reports a failure the wrapper surfaces a single aggregated toast
 * naming the failed paths and throws `PendingWritesFailedError` so the
 * caller can bail before issuing the IPC.
 *
 * The thin IPC wrappers (`renameVaultPath`, `deleteVaultPath`,
 * `createVaultFolder`, `copyFileIntoVault`) are convenience helpers for
 * single-step sites: drain + IPC. Complex sites that need a pre-IPC
 * snapshot read (e.g. `vaultFolderOps.delete` capturing .md bodies for the
 * undoable cascade) wrap their full sequence in `withDrainedWrites(async
 * () => { ... })` so the snapshot reads happen post-flush.
 *
 * Re-entrancy: a nested `withDrainedWrites` call short-circuits its own
 * drain (the outer drain already covers it). The convenience IPC helpers
 * are therefore safe to call from inside a `withDrainedWrites` callback
 * — no double-drain cost, no risk of a stale flush.
 *
 * CI gate: `scripts/check-no-raw-disk-shape-ipc.mjs` forbids raw renderer
 * invokes of the four disk-shape channels (vault rename / delete /
 * create-folder / copy-file) outside this module, the main-process IPC
 * handlers, and a small allowlist of `.filo/` sentinel cleanup sites
 * (which delete recovery breadcrumbs, not user files).
 */

import { flushAllMarkdownWriters } from './markdownFileWriter';
import { flushAllPendingFrontmatterWrites } from '../boards/frontmatterWriteScheduler';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { uiStore } from '../../stores/ui.svelte';
import type {
  ChannelArgs,
  ChannelResult,
} from '@shared/ipcContracts';

interface MarkdownFlushResult {
  ok: number;
  failed: Array<{ ownerId: string; error: unknown }>;
}

interface FrontmatterFlushResult {
  failed: string[];
}

interface BoardFlushResult {
  failed: string[];
}

export interface PendingWritesFailedDetail {
  md: MarkdownFlushResult;
  fm: FrontmatterFlushResult;
  board: BoardFlushResult;
}

export class PendingWritesFailedError extends Error {
  readonly results: PendingWritesFailedDetail;

  constructor(results: PendingWritesFailedDetail) {
    const totalFailed =
      results.md.failed.length + results.fm.failed.length + results.board.failed.length;
    super(
      `Pending writes failed (${totalFailed} file(s)): refusing to proceed with disk-shape change.`,
    );
    this.name = 'PendingWritesFailedError';
    this.results = results;
  }
}

/**
 * Re-entrancy guard. Nested calls reuse the outer drain instead of running
 * their own — every IPC convenience helper calls `withDrainedWrites`, so a
 * complex sequence like `vaultFolderOps.delete` can wrap itself once and
 * still call `deleteVaultPath` for the IPC without paying a second drain.
 */
let drainInProgress = false;

function summariseFailedPaths(results: PendingWritesFailedDetail): string[] {
  const out: string[] = [];
  for (const entry of results.md.failed) out.push(entry.ownerId);
  for (const path of results.fm.failed) out.push(path);
  for (const path of results.board.failed) out.push(path);
  return out;
}

/**
 * Drains the three writer pipelines in parallel, then runs `op` if every
 * drain succeeded. On partial failure: surfaces an aggregated toast naming
 * up to the first three failed targets and throws
 * `PendingWritesFailedError` so the caller can refuse to invoke the IPC.
 *
 * The drain order is parallel (writers don't share state) but the
 * post-drain `op` is sequential after every drain has resolved, so a
 * caller that schedules a new write between drain and op will *not* be
 * caught — that's a design call: keystrokes during a rename are rare
 * enough that re-arming a 300 ms debounce mid-rename is acceptable.
 */
export async function withDrainedWrites<T>(op: () => Promise<T>): Promise<T> {
  if (drainInProgress) {
    // Already inside an outer drain — re-entrant call short-circuits its
    // own drain and just runs the op. Without this guard, every complex
    // sequence (e.g. delete-with-snapshots calling deleteVaultPath) would
    // pay an unnecessary second drain on every IPC helper invocation.
    return op();
  }
  drainInProgress = true;
  try {
    const [mdResult, fmResult, boardResult] = await Promise.all([
      flushAllMarkdownWriters(),
      flushAllPendingFrontmatterWrites(),
      boardCacheStore.flushAllDirty(),
    ]);

    const detail: PendingWritesFailedDetail = {
      md: mdResult,
      fm: fmResult,
      board: boardResult,
    };

    const totalFailed =
      mdResult.failed.length + fmResult.failed.length + boardResult.failed.length;

    if (totalFailed > 0) {
      const failedPaths = summariseFailedPaths(detail);
      const sample = failedPaths.slice(0, 3).join(', ');
      const more =
        failedPaths.length > 3 ? `, +${failedPaths.length - 3} more` : '';
      uiStore.pushToast({
        text: `Couldn't complete the operation — ${totalFailed} pending write${totalFailed === 1 ? '' : 's'} failed: ${sample}${more}. Resolve the save errors above and try again.`,
        type: 'error',
        duration: 0,
      });
      throw new PendingWritesFailedError(detail);
    }

    return await op();
  } finally {
    drainInProgress = false;
  }
}

// ── Thin IPC wrappers (drain + invoke) ────────────────────────────────
//
// Each wrapper drains the three writer pipelines, then issues exactly one
// IPC. The CI gate forbids raw renderer invokes of the four disk-shape
// channels outside this module, so every disk-shape change in the
// renderer routes through these helpers.
//
// Complex call sites that need pre-IPC reads (e.g. snapshot the .md body
// for an undoable delete) wrap their full sequence in `withDrainedWrites`
// directly. The helpers are still callable inside that block — the
// re-entrancy guard collapses the inner drain into a no-op.

/**
 * Renames or moves a vault file/folder. Drains pending writers first so
 * an editor's 300 ms debounce can't fire against the OLD path after the
 * rename moves the file out from under it.
 *
 * Returns the IPC envelope verbatim (`{ success, code? }`) so callers
 * can branch on `code === 'ENOENT'` / `'EACCES'` / `'TARGET_EXISTS'`
 * the same way they did before this gateway existed.
 */
export async function renameVaultPath(
  vaultRoot: string,
  oldPath: string,
  newPath: string,
): Promise<ChannelResult<'vault:rename'>> {
  return withDrainedWrites(async () => {
    return window.filo.invoke('vault:rename', vaultRoot, oldPath, newPath);
  });
}

/**
 * Deletes a vault file or folder. Drains pending writers first so a
 * keystroke that landed in a TextTile within the 300 ms debounce window
 * doesn't fire after the file is gone (ENOENT) or — worse — get
 * resurrected by the writer's `mkdir-recursive` retry.
 *
 * The `itemPath` is the full vault-relative path; the main-process
 * handler resolves it against the captured `vaultRoot` and refuses any
 * relative path that escapes the tree.
 */
export async function deleteVaultPath(
  vaultRoot: string,
  itemPath: string,
): Promise<ChannelResult<'vault:delete'>> {
  return withDrainedWrites(async () => {
    return window.filo.invoke('vault:delete', vaultRoot, itemPath);
  });
}

/**
 * Creates a folder under the vault root. Drains first so a debounced write
 * targeting a same-named file (e.g. a Kanban folder rename mid-flight)
 * doesn't race the `mkdir`.
 */
export async function createVaultFolder(
  ...args: ChannelArgs<'vault:create-folder'>
): Promise<ChannelResult<'vault:create-folder'>> {
  return withDrainedWrites(async () => {
    return window.filo.invoke('vault:create-folder', ...args);
  });
}

/**
 * Imports a file from outside the vault into the vault root (or
 * `destFolder` if supplied). Drains pending writers first so a debounced
 * `.board.json` write that references the destination filename lands BEFORE
 * the copy creates a new file at the same path — otherwise the board cache
 * write could clobber the just-imported file via `vault:write-file-text`'s
 * `mkdir -p` resurrection logic.
 */
export async function copyFileIntoVault(
  ...args: ChannelArgs<'vault:copy-file'>
): Promise<ChannelResult<'vault:copy-file'>> {
  return withDrainedWrites(async () => {
    return window.filo.invoke('vault:copy-file', ...args);
  });
}

// ── Test-only helpers ─────────────────────────────────────────────────

/**
 * Resets the re-entrancy guard. Used by unit tests that throw mid-drain
 * and need to start the next case from a clean slate. Production code
 * should never need this — the `finally` block always clears the flag.
 */
export function __resetDrainGuardForTests(): void {
  drainInProgress = false;
}
