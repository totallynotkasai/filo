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
import { flushAllMisc } from '../boards/miscWriteScheduler';
import { flushScheduledConfig } from '../boards/configWriteScheduler';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { currentVaultGeneration } from './vaultIdentity';
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

interface MiscFlushResult {
  failed: string[];
}

interface ConfigFlushResult {
  failed: string[];
}

export interface PendingWritesFailedDetail {
  md: MarkdownFlushResult;
  fm: FrontmatterFlushResult;
  board: BoardFlushResult;
  misc: MiscFlushResult;
  config: ConfigFlushResult;
}

export class PendingWritesFailedError extends Error {
  readonly results: PendingWritesFailedDetail;

  constructor(results: PendingWritesFailedDetail) {
    const totalFailed =
      results.md.failed.length +
      results.fm.failed.length +
      results.board.failed.length +
      results.misc.failed.length +
      results.config.failed.length;
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
 *
 * G1 — keyed by the vault GENERATION rather than a bare boolean. A bare
 * `drainInProgress = true` would make a `withDrainedWrites` issued against a
 * NEWLY-swapped vault (while an outer drain for the OLD vault is still in
 * flight on its `await`) short-circuit its own drain as "re-entrant" — so the
 * new vault's disk-shape op would run WITHOUT draining the new vault's
 * writers. Scoping to the generation means a call only counts as re-entrant
 * when it shares the generation of the in-flight drain.
 *
 * Audit-17 3.4 — `drainPromise` distinguishes a genuinely NESTED call (op()
 * invoking a convenience helper — runs only after the drain settled) from a
 * CONCURRENT sibling that arrives while the drain is still in flight (e.g. a
 * watcher-driven `handleExternalRename` landing while a user-initiated delete
 * is parked behind a board drift prompt for up to ~60 s). Both used to take
 * the bare `return op()` short-circuit, so the sibling's disk-shape op ran
 * with NO drain at all. Siblings now await the in-flight drain: it resolves
 * `true` on success (proceed with the op — the writers are drained), `false`
 * on failure (fall back to a fresh `withDrainedWrites` pass that runs its own
 * drain and surfaces its own failure). A nested call sees an already-resolved
 * `true` and proceeds immediately — identical to the old short-circuit.
 */
let drainingGeneration: number | null = null;
let drainPromise: Promise<boolean> | null = null;

function summariseFailedPaths(results: PendingWritesFailedDetail): string[] {
  const out: string[] = [];
  for (const entry of results.md.failed) out.push(entry.ownerId);
  for (const path of results.fm.failed) out.push(path);
  for (const path of results.board.failed) out.push(path);
  for (const path of results.misc.failed) out.push(path);
  for (const path of results.config.failed) out.push(path);
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
  const generation = currentVaultGeneration();
  if (drainingGeneration === generation && drainPromise) {
    // Already covered by an outer drain for THIS vault generation. Two cases:
    //  - NESTED call (op() invoking a convenience helper): the outer drain has
    //    already settled successfully (op only runs post-drain), so the await
    //    below resolves `true` immediately and we just run the op — the old
    //    short-circuit, with no second drain cost.
    //  - CONCURRENT sibling (Audit-17 3.4): the outer drain is still in
    //    flight (possibly parked behind an interactive drift prompt). Await it
    //    rather than running the op un-drained. On drain success the writers
    //    are quiescent for this generation, so the sibling op proceeds; on
    //    drain failure, re-enter so the sibling runs (and surfaces) its OWN
    //    drain — by then the failed pass has cleared the guard, and the
    //    recursion also re-captures the generation in case a vault swap
    //    landed while we were parked.
    const outerDrainSucceeded = await drainPromise;
    if (outerDrainSucceeded) return op();
    return withDrainedWrites(op);
  }
  drainingGeneration = generation;
  // Audit-17 3.4 — settled `true` once every writer pipeline drained clean
  // (before op runs), `false` if the drain failed. Never rejects, so a parked
  // sibling can't crash on an error that the outer call already surfaced.
  let settleDrain: (ok: boolean) => void = () => {};
  drainPromise = new Promise<boolean>((resolve) => { settleDrain = resolve; });
  try {
    // 6.4.M1 — misc + config schedulers must drain alongside md/fm/board.
    // Without them, a debounced sidebar-order / viewports / tags.json /
    // workspace.json write fires AFTER the disk-shape op lands, racing the
    // rename or resurrecting a path the IPC just removed.
    //
    // `flushScheduledConfig`'s param is a vestigial getter — the underlying
    // scheduler captures args at schedule time. We pass `() => null` so the
    // signature stays satisfied without coupling this module to the project
    // store's `getConfigWriteArgs`.
    const [mdResult, fmResult, boardResult, miscResult, configResult] =
      await Promise.all([
        flushAllMarkdownWriters(),
        flushAllPendingFrontmatterWrites(),
        boardCacheStore.flushAllDirty(),
        flushAllMisc(),
        flushScheduledConfig(() => null),
      ]);

    const detail: PendingWritesFailedDetail = {
      md: mdResult,
      fm: fmResult,
      board: boardResult,
      misc: miscResult,
      config: { failed: configResult?.failed ?? [] },
    };

    const totalFailed =
      mdResult.failed.length +
      fmResult.failed.length +
      boardResult.failed.length +
      miscResult.failed.length +
      (configResult?.failed.length ?? 0);

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

    // Drain phase complete — release any concurrent siblings parked above
    // BEFORE the op runs (their ops were never serialised behind the outer
    // op, only behind the drain).
    settleDrain(true);
    return await op();
  } finally {
    // Only clear if we're still the generation that set it. A swap mid-drain
    // bumps `currentVaultGeneration()`; if a newer-generation drain set the
    // flag in the meantime, this stale `finally` must not clear ITS flag
    // (or its drainPromise).
    if (drainingGeneration === generation) {
      drainingGeneration = null;
      drainPromise = null;
    }
    // Idempotent: a no-op on the success path (already settled `true`);
    // settles `false` when the drain threw so parked siblings re-enter.
    settleDrain(false);
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
  drainingGeneration = null;
  drainPromise = null;
}
