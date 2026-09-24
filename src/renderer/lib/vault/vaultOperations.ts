/**
 * Single entry point for every disk-shape change.
 *
 * A disk-shape change that doesn't first flush pending writers loses data: a
 * debounced write fires after a rename/delete (ENOENT → silent loss), or an
 * undo snapshot reads `.md` from disk before pending edits land.
 *
 * `withDrainedWrites(op)` enforces the contract by design: every disk-shape
 * change first drains the writer pipelines, then runs `op`. If any
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
 * CI gate: `scripts/gates:no-raw-disk-shape-ipc` forbids raw renderer
 * invokes of the four disk-shape channels (vault rename / delete /
 * create-folder / copy-file) outside this module, the main-process IPC
 * handlers, and a small allowlist of `.filo/` sentinel cleanup sites
 * (which delete recovery breadcrumbs, not user files).
 */

import { flushAllMarkdownWriters } from './markdownFileWriter';
import { flushAllPendingFrontmatterWrites } from '../boards/frontmatterWriteScheduler';
import { flushAllMisc } from '../boards/miscWriteScheduler';
import { flushScheduledConfig } from '../boards/configWriteScheduler';
import { isBoardPathHeld } from '../boards/boardWriteScheduler';
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
 * Keyed by the vault GENERATION rather than a bare boolean: otherwise a call
 * against a NEWLY-swapped vault (while an outer drain for the OLD vault is
 * still awaiting) would skip its own drain as "re-entrant" and run the new
 * vault's disk-shape op without draining its writers.
 *
 * `drainPromise` distinguishes a genuinely NESTED call (op() invoking a
 * convenience helper — runs only after the drain settled) from a CONCURRENT
 * sibling arriving while the drain is still in flight (e.g. an external
 * rename landing while a delete is parked behind a drift prompt for up to
 * ~60 s). Siblings await the in-flight drain instead of running un-drained;
 * a nested call sees it already resolved and proceeds immediately.
 */
/**
 * The in-flight drain's outcome, carried IN `drainPromise` so a parked
 * sibling can react without re-running its own full drain:
 *  - `{ ok: true }` — every writer pipeline drained clean; the sibling proceeds
 *    (after a vault-generation re-check, see below).
 *  - `{ ok: false, detail }` — the drain failed the `totalFailed` check; the
 *    sibling throws the SAME `PendingWritesFailedError` (re-draining per
 *    sibling would cost up to ~60 s each and re-toast).
 *  - `{ ok: false, detail: null }` — an UNEXPECTED drain/op rejection (a flush
 *    threw, not the `totalFailed` branch); the sibling bails too.
 * Carrying the verdict in the promise (rather than a separate module var) makes
 * it immune to the finally-clears-it-before-the-await-resolves race.
 */
type DrainOutcome = { ok: true } | { ok: false; detail: PendingWritesFailedDetail | null };

let drainingGeneration: number | null = null;
let drainPromise: Promise<DrainOutcome> | null = null;

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
    //    below resolves `{ ok: true }` immediately and we just run the op with
    //    no second drain cost.
    //  - CONCURRENT sibling: the outer drain is still in flight (possibly
    //    parked behind an interactive drift prompt for up to ~60 s). Await it
    //    rather than running the op un-drained.
    const outcome = await drainPromise;
    if (outcome.ok) {
      // Re-validate AFTER the park: a vault swap during it would otherwise run
      // this op's stale captured inputs against the NEW vault. Main's
      // `assertActiveVault` gates the disk IPC, but the in-memory half of a
      // cascade op is not gated — bail loudly.
      if (currentVaultGeneration() !== generation) {
        throw new Error(
          'Vault changed during write drain — refusing the disk-shape op (stale generation).',
        );
      }
      return op();
    }
    // The outer drain FAILED. Share its verdict rather than re-draining per
    // sibling (up to ~60 s each, re-toasting). The outer call already toasted,
    // so throw the same error (or a generic one for an unexpected rejection)
    // and let the caller bail.
    throw outcome.detail
      ? new PendingWritesFailedError(outcome.detail)
      : new Error('Pending writes drain failed — refusing the disk-shape op.');
  }
  drainingGeneration = generation;
  // `drainPromise` carries the drain outcome
  // (see `DrainOutcome`): settled `{ ok: true }` once every writer pipeline
  // drained clean (before op runs), `{ ok: false, detail }` on a `totalFailed`
  // drain, `{ ok: false, detail: null }` on an unexpected rejection. Never
  // rejects, so a parked sibling can't crash on an error the outer call already
  // surfaced.
  let settleDrain: (outcome: DrainOutcome) => void = () => {};
  drainPromise = new Promise<DrainOutcome>((resolve) => { settleDrain = resolve; });
  try {
    // Misc + config schedulers must drain alongside md/fm/board.
    // Without them, a debounced sidebar-order / viewports / tags.json /
    // workspace.json write fires AFTER the disk-shape op lands, racing the
    // rename or resurrecting a path the IPC just removed.
    //
    // `flushScheduledConfig`'s param is a vestigial getter — the underlying
    // scheduler captures args at schedule time. We pass `() => null` so the
    // signature stays satisfied without coupling this module to the project
    // store's `getConfigWriteArgs`.
    const [mdResult, fmResult, boardDrain, miscResult, configResult] =
      await Promise.all([
        flushAllMarkdownWriters(),
        flushAllPendingFrontmatterWrites(),
        boardCacheStore.flushAllDirty(),
        flushAllMisc(),
        flushScheduledConfig(() => null),
      ]);

    // A HELD board write (its file vanished on disk, e.g. an
    // external folder rename, and the re-check is pending) fails by design.
    // It must not block the disk-shape op: the external-rename cascade that
    // REBINDS that very board runs inside this drain, and aborting it would
    // strand the board at its old path. The write stays retained + failed.
    const boardResult = { ...boardDrain, failed: boardDrain.failed.filter((p) => !isBoardPathHeld(p)) };
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
      // Settle the failure DETAIL into drainPromise before the
      // throw so parked siblings bail with the same error (no re-drain).
      settleDrain({ ok: false, detail });
      throw new PendingWritesFailedError(detail);
    }

    // Drain phase complete — release any concurrent siblings parked above
    // BEFORE the op runs (their ops were never serialised behind the outer
    // op, only behind the drain).
    settleDrain({ ok: true });
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
    // Idempotent (first settle wins): a no-op on the success path (already
    // `{ ok: true }`) and the totalFailed path (already `{ ok: false, detail }`
    // above). Catches an UNEXPECTED drain/op rejection (a flush threw, not the
    // totalFailed branch) → `{ ok: false, detail: null }` so parked siblings
    // bail rather than hang on a promise that never resolves.
    settleDrain({ ok: false, detail: null });
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
 * can branch on `code === 'ENOENT'` / `'EACCES'` / `'TARGET_EXISTS'`.
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
