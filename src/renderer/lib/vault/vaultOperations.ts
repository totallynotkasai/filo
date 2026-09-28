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
 * Nesting is explicit: `op` receives a `DrainToken`, and a call made from
 * inside it passes the token on (`{ within: token }`, or the helpers' last
 * argument) to run at once under the outer drain. Any other call made while a
 * drained op runs waits for that op to finish, then drains for itself, so it
 * never runs undrained alongside a long op. A nested call that forgets the
 * token waits for the op that is waiting for it: a deadlock, which a dev-mode
 * watchdog reports after 30 s.
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
 * Handed to a drained op. Passing it to a nested `withDrainedWrites` (or an
 * IPC helper) runs that call inside the op's drain. It counts only while the
 * op (or a nested call it started) runs, and only in the vault it was issued
 * for: a kept token is ignored later, and the call then drains for itself.
 */
export interface DrainToken {
  readonly generation: number;
}

/** What a live token stands for. */
interface HeldToken {
  /** The drain's result, which each nested call judges against its own scope. */
  detail: PendingWritesFailedDetail;
  /** Nested calls still running: the next op waits for them too. */
  nested: Set<Promise<unknown>>;
}

// allow-module-state: each entry lives only while its op runs, and a token counts only in its own vault generation
const liveTokens = new Map<DrainToken, HeldToken>();

/**
 * One drain and the op(s) run on it. A call arriving while the drain is still
 * in flight shares its result once its turn comes, as long as no op has run
 * since: re-draining would only re-fire the same failed writes (up to ~60 s
 * each) and toast again. Once an op has run, a later call drains afresh.
 */
interface DrainRun {
  /** Null until the drain finished, and for a drain that threw. */
  detail: PendingWritesFailedDetail | null;
  opStarted: boolean;
}

/**
 * The calls of one vault generation, one at a time. Per generation, so a call
 * for a newly opened vault never waits behind the outgoing vault's op (which
 * stops on its own vault checks).
 */
interface DrainQueue {
  generation: number;
  /** Settles when the last queued call is done. */
  tail: Promise<void>;
  /** Calls queued or running. */
  depth: number;
  /** The drain of the running call. */
  run: DrainRun | null;
}

let queue: DrainQueue | null = null;

/**
 * A queued call that waits this long is almost certainly a nested call that
 * didn't pass its token and waits for the op that waits for it.
 */
const QUEUE_WAIT_WARN_MS = 30_000;

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
  /**
   * The token of the drained op this call is made from. It then runs at once
   * under that op's drain; without it, it would wait for that op to finish,
   * and the op for it.
   */
  within?: DrainToken;
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
export async function withDrainedWrites<T>(
  op: (token: DrainToken) => Promise<T>,
  scope: DrainScope = {},
): Promise<T> {
  const generation = currentVaultGeneration();
  const within = scope.within;
  const held = within && within.generation === generation ? liveTokens.get(within) : undefined;
  if (within && held) {
    // Made from inside a running op: that op's drain covers it, judged against
    // this call's own scope.
    refuseIfBlocked(held.detail, scope);
    const nested = op(within);
    held.nested.add(nested);
    try {
      return await nested;
    } finally {
      held.nested.delete(nested);
    }
  }

  if (!queue || queue.generation !== generation) {
    queue = { generation, tail: Promise.resolve(), depth: 0, run: null };
  }
  const q = queue;
  const mustWait = q.depth > 0;
  const shared = q.run && !q.run.opStarted ? q.run : null;
  const prev = q.tail;
  let done: () => void = () => {};
  q.tail = new Promise<void>((resolve) => { done = resolve; });
  q.depth++;
  try {
    if (mustWait) {
      await waitForTurn(prev);
      // A vault swap while this call waited: its captured inputs belong to the
      // previous vault. Main's `assertActiveVault` gates the disk IPC, but the
      // in-memory half of a cascade op is not gated, so refuse.
      if (currentVaultGeneration() !== generation) {
        throw new Error(
          'Vault changed while waiting for another disk-shape op — refusing this one (stale generation).',
        );
      }
      if (shared && !shared.opStarted) {
        if (!shared.detail) {
          throw new Error('Pending writes drain failed — refusing the disk-shape op.');
        }
        q.run = shared;
        refuseIfBlocked(shared.detail, scope);
        shared.opStarted = true;
        return await runHolding(op, generation, shared.detail);
      }
    }
    const run: DrainRun = { detail: null, opStarted: false };
    q.run = run;
    const detail = await drainWriters();
    run.detail = detail;
    refuseIfBlocked(detail, scope);
    run.opStarted = true;
    return await runHolding(op, generation, detail);
  } finally {
    q.depth--;
    if (q.depth === 0) q.run = null;
    done();
  }
}

/** Waits for the call ahead; in dev, says so when that takes suspiciously long. */
async function waitForTurn(prev: Promise<void>): Promise<void> {
  if (!import.meta.env.DEV) {
    await prev;
    return;
  }
  const queuedAt = new Error('The waiting withDrainedWrites call');
  const timer = setTimeout(() => {
    console.warn(
      `[vaultOperations] A disk-shape operation has waited over ${QUEUE_WAIT_WARN_MS / 1000} s for the one before it. If that one is waiting for this one, a nested call is missing its DrainToken ({ within: token }).`,
      queuedAt,
    );
  }, QUEUE_WAIT_WARN_MS);
  try {
    await prev;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `op` with a live token. The next queued call starts only once the op
 * and every nested call it started have settled, even ones it didn't await,
 * so no drain runs alongside them.
 */
async function runHolding<T>(
  op: (token: DrainToken) => Promise<T>,
  generation: number,
  detail: PendingWritesFailedDetail,
): Promise<T> {
  const token: DrainToken = Object.freeze({ generation });
  const held: HeldToken = { detail, nested: new Set() };
  liveTokens.set(token, held);
  try {
    return await op(token);
  } finally {
    while (held.nested.size > 0) await Promise.allSettled([...held.nested]);
    liveTokens.delete(token);
  }
}

/** Every writer pipeline, flushed in parallel; what failed. */
async function drainWriters(): Promise<PendingWritesFailedDetail> {
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
  return {
    notes: noteResult,
    board: boardResult,
    misc: miscResult,
    config: { failed: configResult?.failed ?? [] },
  };
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
// directly. The helpers are still callable inside that block when given the
// block's `DrainToken` (their last argument): they then run under its drain.

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
  within?: DrainToken,
): Promise<ChannelResult<'vault:rename'>> {
  return withDrainedWrites(async () => {
    // The write queue of the note, or of every note in the folder, stays idle
    // while it moves: a write that started now would land on the old path (or
    // recreate it).
    return noteStore.hold(relPathsOf(vaultRoot, [oldPath, newPath]), async () => {
      return window.filo.invoke('vault:rename', vaultRoot, oldPath, newPath);
    });
  }, { paths: [oldPath, newPath], within });
}

/** The vault-relative paths of `absPaths` (files or folders). */
function relPathsOf(vaultRoot: string, absPaths: string[]): string[] {
  const rels: string[] = [];
  for (const abs of absPaths) {
    const rel = toVaultRelative(abs, vaultRoot);
    if (rel) rels.push(rel);
  }
  return rels;
}

/**
 * Moves a vault file or folder (vault-relative) into Filo's trash,
 * `.filo/trash/<trashId>/`. Every user-facing delete removes things this way;
 * undo and Settings → Trash move them back with `restoreTrashed`. Drains
 * pending writers first so a debounced write can't recreate the path after it
 * moved, and holds the write queue of the note (or of every note in the
 * folder) while it goes.
 */
export async function trashVaultPath(
  vaultRoot: string,
  relPath: string,
  within?: DrainToken,
): Promise<ChannelResult<'vault:trash-move'>> {
  return withDrainedWrites(async () => {
    return noteStore.hold([relPath], async () => {
      return window.filo.invoke('vault:trash-move', vaultRoot, relPath);
    });
  }, { paths: [relPath], within });
}

/**
 * Moves a trashed item back to where it was, or beside it when that path is
 * taken again (`alongside`). `originalPath` names the note (or folder) whose
 * write queues are held while it comes back.
 */
export async function restoreTrashed(
  vaultRoot: string,
  trashId: string,
  originalPath: string,
  within?: DrainToken,
): Promise<ChannelResult<'vault:trash-restore'>> {
  return withDrainedWrites(async () => {
    return noteStore.hold([originalPath], async () => {
      return window.filo.invoke('vault:trash-restore', vaultRoot, trashId);
    });
  }, { paths: [originalPath], within });
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
  }, { paths: [copyTarget(args[0], args[2] ?? '')] });
}

/** Where an import lands: the source's file name in the destination folder ('' = vault root). */
function copyTarget(sourcePath: string, destFolder: string): string {
  const name = toPosix(sourcePath).split('/').pop() ?? '';
  const folder = toPosix(destFolder).replace(/\/+$/, '');
  return folder ? `${folder}/${name}` : name;
}

// ── Test-only helpers ─────────────────────────────────────────────────

/**
 * Forgets the queue and every live token. Used by unit tests that leave an op
 * parked and need to start the next case from a clean slate. Production code
 * should never need this: each call releases its turn in a `finally`.
 */
export function __resetDrainGuardForTests(): void {
  queue = null;
  liveTokens.clear();
}
