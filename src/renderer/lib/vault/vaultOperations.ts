/**
 * Single entry point for every disk-shape change.
 *
 * A disk-shape change that doesn't first flush pending writers loses data: a
 * debounced write fires after a rename/delete (ENOENT → silent loss), or
 * recreates the path the change just removed.
 *
 * `withDrainedWrites(op)` enforces the contract by design: every disk-shape
 * change first drains the writer pipelines, then runs `op`. If a write
 * failed on a path the change touches (`{ paths }`: the path itself, a folder
 * above it or a file below it; every path when no scope is given), the
 * wrapper surfaces a single aggregated toast naming the failed paths and
 * throws `PendingWritesFailedError` so the caller can bail before issuing the
 * IPC. A failure elsewhere keeps its own error toast and doesn't block.
 *
 * The thin IPC wrappers (`renameVaultPath`, `trashVaultPath`,
 * `restoreTrashed`, `createVaultFolder`, `copyFileIntoVault`) are convenience
 * helpers for single-step sites: drain + IPC. Complex sites (the sidebar
 * rename and delete cascades) wrap their full sequence in
 * `withDrainedWrites(async () => { ... })`.
 *
 * Re-entrancy: a nested `withDrainedWrites` call short-circuits its own
 * drain (the outer drain already covers it). The convenience IPC helpers
 * are therefore safe to call from inside a `withDrainedWrites` callback
 * — no double-drain cost, no risk of a stale flush.
 *
 * CI gate: `scripts/gates:no-raw-disk-shape-ipc` forbids raw renderer
 * invokes of the disk-shape channels (vault rename / delete / create-folder /
 * copy-file and the trash channels) outside this module, the main-process IPC
 * handlers, and a small allowlist of `.filo/` sentinel cleanup sites
 * (which delete recovery breadcrumbs, not user files).
 */

import { noteStore } from '../../stores/notes.svelte';
import { toPosix, toVaultRelative } from '../utils/path';
import { flushAllMisc } from '../boards/miscWriteScheduler';
import { flushScheduledConfig } from '../boards/configWriteScheduler';
import { isBoardPathHeld } from '../boards/boardWriteScheduler';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { currentVaultGeneration } from './vaultIdentity';
import { getActiveVaultPath } from './activeVaultPath';
import { vaultPath } from '@shared/vaultPath';
import type {
  ChannelArgs,
  ChannelResult,
} from '@shared/ipcContracts';

interface NoteFlushResult {
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
  notes: NoteFlushResult;
  board: BoardFlushResult;
  misc: MiscFlushResult;
  config: ConfigFlushResult;
}

export class PendingWritesFailedError extends Error {
  readonly results: PendingWritesFailedDetail;

  constructor(results: PendingWritesFailedDetail) {
    const totalFailed =
      results.notes.failed.length +
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
 * still call `trashVaultPath` for the IPC without paying a second drain.
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
 *  - `{ detail }` — every writer pipeline drained; `detail` lists what failed
 *    (maybe nothing). Each call then decides for its own scope whether a
 *    failure blocks it (see `blockingFailures`), so a sibling never re-drains
 *    (up to ~60 s each).
 *  - `{ detail: null }` — an UNEXPECTED drain/op rejection (a flush threw);
 *    the sibling bails too.
 * Carrying the verdict in the promise (rather than a separate module var) makes
 * it immune to the finally-clears-it-before-the-await-resolves race.
 */
type DrainOutcome = { detail: PendingWritesFailedDetail | null };

let drainingGeneration: number | null = null;
let drainPromise: Promise<DrainOutcome> | null = null;

function summariseFailedPaths(results: PendingWritesFailedDetail): string[] {
  const out: string[] = [];
  for (const path of results.notes.failed) out.push(path);
  for (const path of results.board.failed) out.push(path);
  for (const path of results.misc.failed) out.push(path);
  for (const path of results.config.failed) out.push(path);
  return out;
}

function totalFailures(results: PendingWritesFailedDetail): number {
  return results.notes.failed.length + results.board.failed.length + results.misc.failed.length + results.config.failed.length;
}

/** What a disk-shape operation touches, for `withDrainedWrites`. */
export interface DrainScope {
  /**
   * The paths the operation creates, moves or removes (vault-relative or
   * absolute under the vault). A failed write blocks it only when its path is
   * one of these, or a folder above or a file below one. Omitted: every
   * failure blocks.
   */
  paths?: string[];
}

/** `p` as a case-folded vault-relative key; an absolute path under the vault is made relative. */
function scopeKey(p: string, vaultRoot: string): string {
  return vaultPath(toVaultRelative(p, vaultRoot) ?? p).replace(/\/+$/, '');
}

function overlaps(a: string, b: string): boolean {
  return a === b || a === '' || b === '' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The failures that block an operation with `scope`: all of them without a
 * scope, else those whose path overlaps one of the scope's paths.
 *
 * DECISION: a pending write can only disturb a disk-shape operation on the
 * same path or a parent/child path (it would land on a path that moved, or
 * recreate one that went). An unrelated failure keeps its own error toast but
 * is no reason to refuse the operation. Close, open, quit and Save don't come
 * through here and still refuse on any failure.
 */
function blockingFailures(detail: PendingWritesFailedDetail, scope: DrainScope): PendingWritesFailedDetail {
  if (!scope.paths) return detail;
  const vaultRoot = getActiveVaultPath();
  const keys = scope.paths.map((p) => scopeKey(p, vaultRoot));
  const hits = (failed: string[]): string[] =>
    failed.filter((f) => {
      const k = scopeKey(f, vaultRoot);
      return keys.some((s) => overlaps(k, s));
    });
  return {
    notes: { failed: hits(detail.notes.failed) },
    board: { failed: hits(detail.board.failed) },
    misc: { failed: hits(detail.misc.failed) },
    config: { failed: hits(detail.config.failed) },
  };
}

/** Throws (after one toast) when `detail` holds a failure that blocks `scope`. */
function refuseIfBlocked(detail: PendingWritesFailedDetail, scope: DrainScope): void {
  const blocking = blockingFailures(detail, scope);
  const total = totalFailures(blocking);
  if (total === 0) return;
  const failedPaths = summariseFailedPaths(blocking);
  const sample = failedPaths.slice(0, 3).join(', ');
  const more = failedPaths.length > 3 ? `, +${failedPaths.length - 3} more` : '';
  uiStore.pushToast({
    text: `Couldn't complete the operation — ${total} pending write${total === 1 ? '' : 's'} failed: ${sample}${more}. Resolve the save errors above and try again.`,
    type: 'error',
    duration: 0,
    // Siblings sharing one failed drain show one toast, not one each.
    dedupeKey: `drain-failed:${failedPaths.join('|')}`,
  });
  throw new PendingWritesFailedError(blocking);
}

/**
 * Drains the writer pipelines in parallel, then runs `op` unless a write
 * that touches `scope` failed. On such a failure: surfaces an aggregated toast
 * naming up to the first three failed targets and throws
 * `PendingWritesFailedError` so the caller can refuse to invoke the IPC.
 *
 * The drain order is parallel (writers don't share state) but the
 * post-drain `op` is sequential after every drain has resolved, so a
 * caller that schedules a new write between drain and op will *not* be
 * caught — that's a design call: keystrokes during a rename are rare
 * enough that re-arming a 300 ms debounce mid-rename is acceptable.
 */
export async function withDrainedWrites<T>(op: () => Promise<T>, scope: DrainScope = {}): Promise<T> {
  const generation = currentVaultGeneration();
  if (drainingGeneration === generation && drainPromise) {
    // Already covered by an outer drain for THIS vault generation. Two cases:
    //  - NESTED call (op() invoking a convenience helper): the outer drain has
    //    already settled (op only runs post-drain), so the await below
    //    resolves immediately and we just run the op with no second drain.
    //  - CONCURRENT sibling: the outer drain is still in flight (possibly
    //    parked behind an interactive drift prompt for up to ~60 s). Await it
    //    rather than running the op un-drained.
    const outcome = await drainPromise;
    if (!outcome.detail) {
      throw new Error('Pending writes drain failed — refusing the disk-shape op.');
    }
    // Share the outer drain's result rather than re-draining, judged against
    // this call's own scope.
    refuseIfBlocked(outcome.detail, scope);
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
  drainingGeneration = generation;
  // `drainPromise` carries the drain outcome (see `DrainOutcome`), settled
  // before op runs. Never rejects, so a parked sibling can't crash on an error
  // the outer call already surfaced.
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
    const [noteResult, boardDrain, miscResult, configResult] =
      await Promise.all([
        noteStore.flushAll(),
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
      notes: noteResult,
      board: boardResult,
      misc: miscResult,
      config: { failed: configResult?.failed ?? [] },
    };

    // Release any concurrent siblings parked above BEFORE the op runs (their
    // ops were never serialised behind the outer op, only behind the drain).
    // Each judges the result against its own scope.
    settleDrain({ detail });
    refuseIfBlocked(detail, scope);
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
    // Idempotent (first settle wins): a no-op once the drain settled above.
    // Catches an UNEXPECTED drain rejection (a flush threw) →
    // `{ detail: null }` so parked siblings bail rather than hang on a
    // promise that never resolves.
    settleDrain({ detail: null });
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
    // A note's write queue stays idle while its file moves: a write that
    // started now would land on the old path (or recreate it).
    return noteStore.hold(notePathsOf(vaultRoot, [oldPath, newPath]), async () => {
      return window.filo.invoke('vault:rename', vaultRoot, oldPath, newPath);
    });
  }, { paths: [oldPath, newPath] });
}

/** The vault-relative paths of `absPaths` that name notes (`.md`). */
function notePathsOf(vaultRoot: string, absPaths: string[]): string[] {
  const rels: string[] = [];
  for (const abs of absPaths) {
    const rel = toVaultRelative(abs, vaultRoot);
    if (rel) rels.push(rel);
  }
  return notePathsOfRel(rels);
}

function notePathsOfRel(rels: string[]): string[] {
  return rels.filter((rel) => /\.(md|markdown)$/i.test(rel));
}

/**
 * Moves a vault file or folder (vault-relative) into Filo's trash,
 * `.filo/trash/<trashId>/`. Every user-facing delete removes things this way;
 * undo and Settings → Trash move them back with `restoreTrashed`. Drains
 * pending writers first so a debounced write can't recreate the path after it
 * moved, and holds the note's write queue while it goes.
 */
export async function trashVaultPath(
  vaultRoot: string,
  relPath: string,
): Promise<ChannelResult<'vault:trash-move'>> {
  return withDrainedWrites(async () => {
    return noteStore.hold(notePathsOfRel([relPath]), async () => {
      return window.filo.invoke('vault:trash-move', vaultRoot, relPath);
    });
  }, { paths: [relPath] });
}

/**
 * Moves a trashed item back to where it was, or beside it when that path is
 * taken again (`alongside`). `originalPath` names the note whose write queue
 * is held while it comes back.
 */
export async function restoreTrashed(
  vaultRoot: string,
  trashId: string,
  originalPath: string,
): Promise<ChannelResult<'vault:trash-restore'>> {
  return withDrainedWrites(async () => {
    return noteStore.hold(notePathsOfRel([originalPath]), async () => {
      return window.filo.invoke('vault:trash-restore', vaultRoot, trashId);
    });
  }, { paths: [originalPath] });
}

/** What is in Filo's trash, newest first. */
export async function listTrash(vaultRoot: string): Promise<ChannelResult<'vault:trash-list'>> {
  return window.filo.invoke('vault:trash-list', vaultRoot);
}

/**
 * Sends trashed items to the OS Recycle Bin: by id, or this machine's items
 * older than 30 days. Items the Recycle Bin refuses stay in Filo's trash and
 * come back as `TRASH_FAILED`; only `deleteTrashPermanently`, after the user
 * confirmed, removes them for good.
 */
export async function purgeTrash(
  vaultRoot: string,
  which: string[] | 'olderThan30d',
): Promise<ChannelResult<'vault:trash-purge'>> {
  return window.filo.invoke('vault:trash-purge', vaultRoot, which);
}

/** Deletes trashed items for good, after the user answered "Delete permanently?". */
export async function deleteTrashPermanently(
  vaultRoot: string,
  trashIds: string[],
): Promise<ChannelResult<'vault:trash-delete-permanently'>> {
  return window.filo.invoke('vault:trash-delete-permanently', vaultRoot, trashIds);
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
  }, { paths: [args[1]] });
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
  }, { paths: [copyTarget(args[0], args[2] ?? args[1])] });
}

/** Where an import lands: the source's file name in the destination folder. */
function copyTarget(sourcePath: string, destFolder: string): string {
  const name = toPosix(sourcePath).split('/').pop() ?? '';
  return `${toPosix(destFolder).replace(/\/+$/, '')}/${name}`;
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
