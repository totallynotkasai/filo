import { watch, type FSWatcher, statSync, promises as fsPromises } from 'fs';
import { BrowserWindow } from 'electron';
import { join } from 'path';
import { correlateRenames } from './renameCorrelation';
import { announceSyncConflicts, loadKnownHosts, knownHostsFor } from './syncConflictNotifier';
import {
  WATCHER_HASH_MAX_BYTES,
  fnv1a32,
  sha1Hex,
  hashFileForRename,
} from './fileWatcherHash';
import { logMainError } from '../utils/mainLogger';
import { toPosix, relativePosix } from '../utils/pathHelpers';
import { vaultPath, type VaultPath } from '../../shared/vaultPath';
import type { FileChangeEvent, FileChangeType } from './fileWatcherTypes';
import {
  WatcherSupervisor,
  type WatcherState,
} from './watcherSupervisor';
import { shouldIgnorePath, classifyChange } from './fileWatcherClassify';

export { correlateRenames } from './renameCorrelation';
export type { FileChangeEvent, FileChangeType } from './fileWatcherTypes';
export type { WatcherState, WatcherStatePayload } from './watcherSupervisor';

interface ReconcileEntry {
  mtimeMs: number;
  size: number;
  /**
   * FNV-1a 32-bit hash of the file content (the whole file under
   * {@link WATCHER_HASH_MAX_BYTES}, a 4 KB prefix above it). Catches the
   * FAT/SMB case where 2-second mtime granularity leaves both stat fields
   * unchanged across two writes. `undefined` for non-`.md`/`.board.json`
   * files (media isn't hashed, for cost) and for files we couldn't open.
   */
  hash?: number;
}

/**
 * How long between reconciliation passes. The walker has to stat every file
 * under the vault, so we can't run it too aggressively. 30s strikes a balance
 * between catching drift quickly enough for the user to notice and not
 * burning I/O on quiet vaults.
 */
const RECONCILE_INTERVAL_MS = 30_000;

// The supervisor state machine + reopen backoff schedule live in
// watcherSupervisor.ts; `FileWatcher` owns one `WatcherSupervisor` per vault.

/**
 * Watches a vault directory for file system changes and notifies
 * the renderer process with categorized change events.
 *
 * Events are debounced (300ms) to batch rapid file system changes.
 *
 * Self-writes (writes performed by Filo itself via the vault:* IPC
 * handlers) are suppressed for a short window via {@link suppress}, so
 * the renderer doesn't receive a watcher event that races its own
 * in-flight write and reload the file mid-edit.
 *
 * Reconciliation: `fs.watch` drops events under load on every platform —
 * Linux inotify limits, macOS rename quirks, network filesystems used for
 * Dropbox/iCloud, and just plain high-churn vaults. To catch drift the
 * watcher runs a periodic reconciliation pass (RECONCILE_INTERVAL_MS) and
 * a one-shot {@link reconcileNow} the renderer can trigger on
 * window-focus. The pass diffs a snapshot of `(path, mtimeMs, size)` against
 * the current tree and synthesises the missed `vault:files-changed` and
 * `vault:file-renamed` events through the same emit pipeline as the live
 * watcher.
 */
/**
 * Every key under `suppressedPaths` / `suppressedPrefixes` /
 * `lastKnownSizes` / `lastKnownHashes` goes through `vaultPath()`, which
 * case-folds unconditionally so suppression and size/hash caches agree on
 * key identity on every platform. Trade-off (accepted codebase-wide): a
 * Linux vault with both `Notes.md` and `notes.md` conflates them here.
 */

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges: FileChangeEvent[] = [];
  private readonly debounceMs = 300;
  // Max-wait cap: a continuous sub-300ms write stream re-arms
  // the trailing debounce forever; the OLDEST unfired event's time lets
  // `scheduleNotify` cap the delay so a flush still lands within ~1s.
  private debounceFirstQueuedAt: number | null = null;
  private readonly maxDebounceWaitMs = 1000;

  /** Vault-relative path -> expiry timestamp (ms since epoch). */
  private suppressedPaths = new Map<VaultPath, number>();

  /**
   * Vault-relative directory prefix -> expiry. Set by {@link suppressTree}
   * before a recursive folder delete; without it each descendant unlink
   * event would show a dirty editor under the folder a "deleted externally"
   * prompt for a delete the user initiated.
   *
   * Map keys are stored WITH a trailing slash (e.g. `notes/old/`) so
   * `isSuppressed`'s `startsWith` check can't accidentally match a
   * sibling folder whose name happens to share a prefix
   * (`notes/old-archive/` won't match `notes/old/`).
   */
  private suppressedPrefixes = new Map<VaultPath, number>();

  /**
   * Vault-relative path -> last observed file size in bytes. Populated each
   * time we successfully stat a path during a flush; consulted by the size
   * probe passed to `correlateRenames` so that the cross-basename rename
   * heuristic can resolve "old path now gone" against its last-known size.
   *
   * Lazily populated: a rename whose source file was never observed in
   * earlier events still won't be paired (the size cache misses), but any
   * file that's been touched at least once during this watcher session
   * will retain its last-known size up to the moment it disappears.
   */
  private lastKnownSizes = new Map<VaultPath, number>();

  /**
   * Per-path content-hash cache. Populated lazily when a
   * file appears in a watcher event AND is small enough to hash cheaply
   * (see `WATCHER_HASH_MAX_BYTES`). Used by `correlateRenames`'s
   * cross-basename pass to refuse pairing two files that share a size
   * but not their content.
   */
  private lastKnownHashes = new Map<VaultPath, string>();

  /**
   * Snapshot of the vault filesystem from the last successful reconciliation
   * pass. Keyed by vault-relative path (with forward slashes). `null` before
   * the first pass — the very first reconciliation treats every file as
   * "newly seen" and seeds the snapshot without firing any events.
   */
  private reconcileSnapshot: Map<string, ReconcileEntry> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileInFlight = false;

  /**
   * The in-flight `reconcileNow()` walk, or `null`. `stop()` awaits it so a
   * walk in progress during a vault swap can't emit the OLD vault's
   * `vault:files-changed` events into the NEW vault's window.
   */
  private reconcileInFlightPromise: Promise<void> | null = null;

  /**
   * The in-flight `notifyRenderers()` pass, or `null`. Its rename hash probes
   * can take hundreds of ms on a slow volume — long enough for a vault swap.
   * `stop()` awaits it so a late rename/change send can't drive the rename
   * cascade against same-named files in the new vault.
   */
  private notifyInFlightPromise: Promise<void> | null = null;

  /**
   * Set by `stop()`. Once true, every emit path
   * (`notifyRenderers`, `scheduleNotify`, the reconcile diff loop) short-
   * circuits so any work that races past the `reconcileInFlight` check
   * cannot fire late events on a torn-down watcher.
   */
  private aborted = false;

  /**
   * Supervisor state machine. Owns the reopen retry schedule +
   * `vault:watcher-state` broadcasts.
   */
  private readonly supervisor: WatcherSupervisor;

  constructor(private vaultPath: string) {
    this.supervisor = new WatcherSupervisor(vaultPath, {
      openLiveWatcher: () => this.openLiveWatcher(),
    });
  }

  /**
   * Suppresses watcher events for `relativePath` for `durationMs`. Called
   * immediately before the IPC handler writes the file, so the OS-generated
   * change event (which arrives during/after the write) is dropped and
   * doesn't race the renderer's own in-memory state.
   *
   * The 500ms default covers: the OS write latency, the 300ms watcher
   * debounce, and a small margin for the next debounce batch. Suppression
   * is path-scoped — external edits to other files are unaffected.
   *
   * Repeated calls only ever EXTEND the window: a shorter later suppress
   * (e.g. board.save's pre + post suppress) must not shrink the expiry and
   * let the rename event slip through on slow disks.
   */
  suppress(relativePath: string, durationMs: number = 500): void {
    // `vaultPath()` case-folds + slash-normalises the key so suppression of
    // `Notes.md` matches an OS-emitted event with `notes.md` casing.
    const normalized = vaultPath(relativePath);
    if (!normalized) return;
    const next = Date.now() + durationMs;
    const current = this.suppressedPaths.get(normalized) ?? 0;
    this.suppressedPaths.set(normalized, Math.max(current, next));
  }

  /**
   * Suppress every watcher event whose path equals OR starts under
   * `relativePath/` for `durationMs`. Called immediately before a recursive
   * folder delete so the per-descendant unlink events don't surface as N
   * "deleted externally" prompts. Extend-only, like {@link suppress}.
   */
  suppressTree(relativePath: string, durationMs: number = 2000): void {
    // Case-fold so the prefix sweep in `isSuppressed` matches OS-emitted
    // casing; the trailing slash is stripped here and re-added below.
    const normalized = vaultPath(relativePath).replace(/\/+$/, '') as VaultPath;
    if (!normalized) return;
    const next = Date.now() + durationMs;
    // Suppress the folder itself (the watcher may emit an event for the
    // folder entry too on some platforms).
    const currentExact = this.suppressedPaths.get(normalized) ?? 0;
    this.suppressedPaths.set(normalized, Math.max(currentExact, next));
    // Suppress everything beneath it. Trailing slash guards against
    // sibling-prefix collisions (see field-level comment on
    // `suppressedPrefixes`).
    const prefix = (normalized + '/') as VaultPath;
    const currentPrefix = this.suppressedPrefixes.get(prefix) ?? 0;
    this.suppressedPrefixes.set(prefix, Math.max(currentPrefix, next));
  }

  private isSuppressed(relativePath: string): boolean {
    // Symmetric `vaultPath()` so an OS-emitted `notes.md` event still
    // matches a `suppress('Notes.md')` entry.
    const normalized = vaultPath(relativePath);
    const expiry = this.suppressedPaths.get(normalized);
    if (expiry !== undefined) {
      if (Date.now() > expiry) {
        this.suppressedPaths.delete(normalized);
      } else {
        return true;
      }
    }
    // Prefix sweep: check every active tree-suppress entry. The map is typically tiny (one entry per in-flight folder
    // delete), so an O(N) scan is cheaper than maintaining a sorted
    // structure.
    const now = Date.now();
    for (const [prefix, exp] of this.suppressedPrefixes.entries()) {
      if (now > exp) {
        this.suppressedPrefixes.delete(prefix);
        continue;
      }
      if (normalized.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * True when `relativePath` is under an active TREE-suppress
   * prefix (`suppressTree`, i.e. an in-flight folder DELETE). The reconcile
   * delete carry-forward (below) uses this to EXCLUDE intentional self-deletes
   * from re-surfacing as external deletes once suppression lifts.
   */
  private isTreeSuppressed(relativePath: string): boolean {
    const normalized = vaultPath(relativePath);
    const now = Date.now();
    for (const [prefix, exp] of this.suppressedPrefixes.entries()) {
      if (now > exp) continue;
      if (normalized.startsWith(prefix)) return true;
    }
    return false;
  }

  private gcSuppressedPaths(): void {
    const now = Date.now();
    for (const [path, expiry] of this.suppressedPaths.entries()) {
      if (now > expiry) this.suppressedPaths.delete(path);
    }
    for (const [prefix, expiry] of this.suppressedPrefixes.entries()) {
      if (now > expiry) this.suppressedPrefixes.delete(prefix);
    }
  }

  /**
   * Broadcast `vault:watcher-failed` to every BrowserWindow so the renderer
   * can toast "external edits won't auto-refresh". Shared by the synchronous
   * fs.watch() exception path and the async 'error' event path. The
   * supervisor's `vault:watcher-state` broadcast fires alongside it.
   */
  private notifyWatcherFailed(err: unknown): void {
    if (this.aborted) return;
    logMainError('fileWatcher.error', err);
    const reason = err instanceof Error ? err.message : String(err);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('vault:watcher-failed', { vaultPath: this.vaultPath, reason });
    }
  }

  /** Test-only state introspection. Delegates to supervisor. */
  getState(): WatcherState {
    return this.supervisor.getState();
  }

  /** Test-only attempt introspection. Delegates to supervisor. */
  getRetryAttempt(): number {
    return this.supervisor.getRetryAttempt();
  }

  /**
   * Test-only deterministic probe of the granular path classifier (the live
   * `fs.watch` callback is non-deterministic in unit tests).
   */
  classifyForTests(relativePath: string): FileChangeType {
    return classifyChange(relativePath);
  }

  start(): void {
    if (this.watcher) return;
    if (this.aborted) return;

    this.openLiveWatcher();
    void loadKnownHosts(this.vaultPath); // OneDrive device names for conflict detection

    // Seed the reconciliation snapshot in the background (the first pass
    // fires no events). The reconcile timer is intentionally independent of
    // the live watcher state — it keeps running during `reconnecting` so
    // external edits still surface (at the 30 s cadence) until the live
    // handle comes back.
    void this.reconcileNow({ seedOnly: true });
    this.reconcileTimer = setInterval(() => {
      void this.reconcileNow({ seedOnly: false });
    }, RECONCILE_INTERVAL_MS);
  }

  /**
   * Opens (or re-opens) the live `fs.watch` handle and
   * wires the error path through the supervisor state machine. Called from
   * `start()` for the initial open and from the supervisor's retry timer
   * on each backoff tick.
   *
   * Returns true on a successful open, false if the synchronous `fs.watch`
   * call threw (the supervisor enters `reconnecting` and schedules the
   * next retry).
   */
  private openLiveWatcher(): boolean {
    if (this.aborted) return false;
    try {
      this.watcher = watch(this.vaultPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Drop events that fire after stop(); otherwise a vault swap can
        // briefly funnel the OUTGOING vault's events into the pending queue.
        if (this.aborted) return;

        const normalized = toPosix(filename);

        if (shouldIgnorePath(normalized)) return;

        const changeType = classifyChange(normalized);
        this.pendingChanges.push({
          type: changeType,
          filename: normalized,
          eventType: eventType || 'change',
        });

        this.scheduleNotify();
      });
      // fs.watch emits async 'error' events when the OS watch handle is
      // invalidated mid-life. The supervisor transitions to `reconnecting`
      // and schedules a retry with exponential backoff.
      this.watcher.on('error', (err) => {
        this.handleWatcherError(err);
      });
      this.supervisor.noteOpenSuccess();
      return true;
    } catch (err) {
      this.handleWatcherError(err);
      return false;
    }
  }

  /**
   * Central error path for the live watcher. Closes the dead handle, emits
   * `vault:watcher-failed`, and hands the supervisor the state transition +
   * retry scheduling.
   */
  private handleWatcherError(err: unknown): void {
    if (this.aborted) return;
    this.notifyWatcherFailed(err);
    // Drop the dead handle so a subsequent vault swap / re-watch can
    // start a fresh watcher without the leftover one's listeners.
    try {
      this.watcher?.close();
    } catch {
      // Already closed by the OS; ignore.
    }
    this.watcher = null;
    const reason = err instanceof Error ? err.message : String(err);
    this.supervisor.noteError(reason);
  }

  /**
   * Async tear-down. Sets `aborted` first so any code path that races past
   * the in-flight checks short-circuits, then awaits the in-flight reconcile
   * walk and notify pass so neither lands late events under the new vault.
   * The map cleanup runs after the awaits, even when they throw.
   */
  async stop(): Promise<void> {
    this.aborted = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.debounceFirstQueuedAt = null; // drop the max-wait marker
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    // Cancels any pending reopen retry timer and broadcasts `suspended`
    // exactly once.
    this.supervisor.shutdown();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    // Await any in-flight reconcile walk so its synthesised events don't
    // land after teardown. `reconcileNow` itself checks `aborted` inside
    // the diff loop, so this either resolves quickly (no walk running) or
    // waits for the abort-aware walk to finish.
    const pendingReconcile = this.reconcileInFlightPromise;
    if (pendingReconcile) {
      try {
        await pendingReconcile;
      } catch {
        // Reconcile errors are already logged inside `reconcileNow`; we
        // just need the synchronisation.
      }
    }
    // Same for an in-flight notify pass: its `await correlateRenames(...)`
    // is exactly where a vault swap can land. vault:close awaits stop()
    // before the candidate load, so awaiting here removes the window.
    const pendingNotify = this.notifyInFlightPromise;
    if (pendingNotify) {
      try {
        await pendingNotify;
      } catch {
        // Notify errors are logged by the scheduleNotify catch; we just
        // need the synchronisation.
      }
    }
    this.pendingChanges = [];
    this.suppressedPaths.clear();
    this.suppressedPrefixes.clear();
    this.lastKnownSizes.clear();
    this.lastKnownHashes.clear();
    this.reconcileSnapshot = null;
    this.reconcileInFlight = false;
    this.reconcileInFlightPromise = null;
    this.notifyInFlightPromise = null;
  }

  /**
   * Walks the vault directory and diffs the current state against the last
   * successful reconciliation snapshot. Synthesises events for any path
   * that was created, deleted, or whose mtime/size changed without an
   * accompanying live watcher event. Pass `seedOnly: true` to populate the
   * snapshot without firing events — used on initial start.
   *
   * Idempotent: if a walk is already running, subsequent calls are no-ops
   * until the in-flight pass finishes (prevents a window-focus burst from
   * stacking up overlapping walks).
   *
   * Surfaces `vault:watcher-failed` if the walker errors (the vault root has
   * gone unreadable) rather than leaving a silently dead watcher.
   */
  async reconcileNow(options: { seedOnly?: boolean } = {}): Promise<void> {
    if (this.reconcileInFlight) return;
    if (this.aborted) return;
    this.reconcileInFlight = true;
    // Publish the in-flight promise so `stop()` can await it. The assignment
    // happens before any await suspension, so a same-tick `stop()` sees it.
    const promise = (async () => {
      try {
        const current = await this.walkVault();
        if (current === null) return;
        if (this.aborted) return;
        const previous = this.reconcileSnapshot;
        // Don't let the snapshot advance past a currently suppressed path.
        // The diff loop SKIPS suppressed paths, so baking their current
        // mtime/size into the snapshot would permanently mask an EXTERNAL
        // change that landed inside the same window. Carry the prior entry
        // forward (or drop a just-appeared path) so the next un-suppressed
        // pass re-diffs it; a pure self-write re-surfaces harmlessly (the
        // renderer finds disk === index).
        if (
          previous !== null
          && !options.seedOnly
          && (this.suppressedPaths.size > 0 || this.suppressedPrefixes.size > 0)
        ) {
          for (const path of [...current.keys()]) {
            if (!this.isSuppressed(path)) continue;
            const priorEntry = previous.get(path);
            if (priorEntry !== undefined) current.set(path, priorEntry);
            else current.delete(path);
          }
          // Same for a path DELETED while suppressed: carry its prior entry
          // forward so an external delete inside a self-write window
          // re-surfaces when the window lifts. Tree-suppressed paths are an
          // intentional folder self-delete, so they're excluded.
          for (const [path, priorEntry] of previous) {
            if (current.has(path)) continue;
            if (!this.isSuppressed(path)) continue;
            if (this.isTreeSuppressed(path)) continue;
            current.set(path, priorEntry);
          }
        }
        this.reconcileSnapshot = current;
        if (options.seedOnly || previous === null) return;

        const synthesised: FileChangeEvent[] = [];
        for (const [path, entry] of current) {
          if (this.aborted) return;
          if (shouldIgnorePath(path)) continue;
          if (this.isSuppressed(path)) continue;
          const prior = previous.get(path);
          if (prior === undefined) {
            synthesised.push({
              type: classifyChange(path),
              filename: path,
              eventType: 'rename',
            });
          } else if (
            prior.mtimeMs !== entry.mtimeMs
            || prior.size !== entry.size
            // Hash differs even with identical mtime+size.
            // Catches FAT/SMB rewrite-within-same-second cases where stat
            // alone would call the change invisible.
            || (prior.hash !== undefined && entry.hash !== undefined && prior.hash !== entry.hash)
          ) {
            synthesised.push({
              type: classifyChange(path),
              filename: path,
              eventType: 'change',
            });
          }
        }
        for (const [path] of previous) {
          if (this.aborted) return;
          if (current.has(path)) continue;
          if (shouldIgnorePath(path)) continue;
          if (this.isSuppressed(path)) continue;
          synthesised.push({
            type: classifyChange(path),
            filename: path,
            eventType: 'rename',
          });
        }
        if (synthesised.length === 0) return;
        // Final abort check before pushing into the live queue — without
        // this, an abort mid-walk could leave events queued that the
        // post-stop reset wipes anyway but the next-tick scheduleNotify
        // wouldn't even fire because we short-circuit there too.
        if (this.aborted) return;

        // Merge into the live pending queue so the existing 300ms debounce
        // batches everything together — including any live watcher events
        // that arrived while we were walking. notifyRenderers handles dedup
        // by (type, filename) so a path that the live watcher and the
        // reconciler both saw won't fire twice.
        this.pendingChanges.push(...synthesised);
        this.scheduleNotify();
      } catch (err) {
        logMainError('fileWatcher.reconcileNow', err);
        // Hard reconciliation failure means we've lost visibility into the
        // vault — surface to the renderer so the user knows external edits
        // may stop appearing. Skip the failure event on abort: the watcher
        // is being torn down anyway, and a "watcher failed" toast against
        // the new vault would be confusing.
        if (this.aborted) return;
        const reason = err instanceof Error ? err.message : String(err);
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('vault:watcher-failed', { vaultPath: this.vaultPath, reason });
        }
      } finally {
        this.reconcileInFlight = false;
        this.reconcileInFlightPromise = null;
      }
    })();
    this.reconcileInFlightPromise = promise;
    await promise;
  }

  /**
   * Recursively walks the vault directory and returns a map of every regular
   * file's vault-relative path to its mtime + size. Returns `null` if the
   * vault root itself can't be opened — the caller surfaces a watcher
   * failure rather than treating the missing root as "vault is empty"
   * (which would synthesise a delete for every known file).
   */
  private async walkVault(): Promise<Map<string, ReconcileEntry> | null> {
    const out = new Map<string, ReconcileEntry>();
    try {
      await fsPromises.access(this.vaultPath);
    } catch {
      return null;
    }
    await this.walkDir(this.vaultPath, out);
    await this.walkFiloConfig(out);
    return out;
  }

  /**
   * The main walk skips `.filo/` wholesale (cache / recovery / viewports
   * rewrite constantly), but the renderer-reconciled config files must still
   * be covered, or an external edit to tags.json / a theme / a template made
   * while the live handle is down would never surface. Stat just the `.filo`
   * paths `classifyChange` maps to a granular `config-*` type. The granular
   * reconcilers are echo-tolerant, so self-writes are harmless.
   */
  private async walkFiloConfig(out: Map<string, ReconcileEntry>): Promise<void> {
    const tagsRel = '.filo/tags.json';
    try {
      const stat = await fsPromises.stat(join(this.vaultPath, tagsRel));
      if (stat.isFile()) {
        out.set(tagsRel, { mtimeMs: stat.mtimeMs, size: stat.size, hash: undefined });
      }
    } catch {
      // No tags.json yet (fresh vault) — nothing to track.
    }
    for (const sub of ['themes', 'templates'] as const) {
      // walkDir's `.filo`-skip only fires at the vault ROOT, so walking the
      // subdirectory directly reuses the EACCES/ENOENT-tolerant walk + the
      // `.tmp`/`.bak` filter; entries land as `.filo/<sub>/…` rel paths.
      await this.walkDir(join(this.vaultPath, '.filo', sub), out);
    }
  }

  private async walkDir(dir: string, out: Map<string, ReconcileEntry>): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // EACCES on a subdirectory is recoverable — just skip the subtree.
      // ENOENT here means the dir was deleted between readdir and stat,
      // which is fine too.
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'EACCES' || code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.git')) continue;
      if (entry.name === '.filo' && dir === this.vaultPath) {
        // .filo is owned by Filo; skip the whole subtree from the main
        // reconciliation walk. Cache, recovery, viewports rewrite often
        // and would produce constant synthesised events for no benefit.
        // The renderer-reconciled config files are re-added by
        // walkFiloConfig().
        continue;
      }
      if (entry.name.endsWith('.tmp') || entry.name.endsWith('.bak')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDir(full, out);
      } else if (entry.isFile()) {
        try {
          const stat = await fsPromises.stat(full);
          const rel = relativePosix(this.vaultPath, full);
          let hash: number | undefined;
          // Hash `.md` + `.board.json` so reconcile can detect mid-second
          // rewrites on filesystems with second-resolution mtime (FAT, SMB,
          // some NFS configs), AND seed the SHA-1 the cross-basename
          // correlator consumes for the now-missing source of a rename. One
          // read feeds both digests so the walk stays at one open per file.
          //
          // Under WATCHER_HASH_MAX_BYTES hash the WHOLE file, so a deep edit
          // past 4 KB is caught and the SHA-1 seed matches the on-demand
          // rename probe's digest. Above the ceiling use a 4 KB-prefix FNV
          // only; the rename gate refuses such pairs, so no SHA-1 is seeded.
          const lower = rel.toLowerCase();
          if (lower.endsWith('.md') || lower.endsWith('.board.json')) {
            try {
              if (stat.size <= WATCHER_HASH_MAX_BYTES) {
                const buf = await fsPromises.readFile(full);
                hash = fnv1a32(buf);
                this.lastKnownHashes.set(vaultPath(rel), sha1Hex(buf));
              } else {
                const fd = await fsPromises.open(full, 'r');
                try {
                  const head = Buffer.alloc(4096);
                  const { bytesRead } = await fd.read(head, 0, 4096, 0);
                  hash = fnv1a32(head.subarray(0, bytesRead));
                } finally {
                  await fd.close();
                }
              }
            } catch {
              // Hash failure isn't fatal; leave undefined and the diff
              // falls back to mtime+size comparison.
            }
          }
          out.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
        } catch {
          // File gone between readdir and stat — race with a concurrent
          // delete. Skip; the next pass picks it up if it stays gone.
        }
      }
    }
  }

  private scheduleNotify(): void {
    // Refuse to arm a new debounce after `stop()`: the live watcher callback
    // may have queued events in the same tick stop() fired.
    if (this.aborted) return;
    // Cap the delay at the remaining max-wait so a sustained
    // sub-debounce stream still flushes (a lone event still gets full debounce).
    const now = Date.now();
    if (this.debounceFirstQueuedAt === null) {
      this.debounceFirstQueuedAt = now;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    const remainingMaxWait = Math.max(0, this.maxDebounceWaitMs - (now - this.debounceFirstQueuedAt));
    const delay = Math.min(this.debounceMs, remainingMaxWait);
    this.debounceTimer = setTimeout(() => {
      // Firing — clear the marker so the NEXT event starts a fresh window.
      this.debounceFirstQueuedAt = null;
      this.debounceTimer = null;
      // Fire-and-forget; the `.catch` logs an unexpected rejection instead
      // of leaving an unhandled promise.
      this.notifyRenderers().catch((err) => {
        logMainError('fileWatcher.notifyRenderers', err);
      });
    }, delay);
  }

  private async notifyRenderers(): Promise<void> {
    // Publish the in-flight handle so `stop()` can await the pass. Cleared
    // only when THIS pass is still the published one, so an overlapping pass
    // can't drop a sibling's handle.
    const promise = this.notifyRenderersImpl();
    this.notifyInFlightPromise = promise;
    try {
      await promise;
    } finally {
      if (this.notifyInFlightPromise === promise) {
        this.notifyInFlightPromise = null;
      }
    }
  }

  private async notifyRenderersImpl(): Promise<void> {
    // Defence in depth: no events are ever emitted from an aborted watcher.
    if (this.aborted) return;
    this.gcSuppressedPaths();
    const changes = [...this.pendingChanges];
    this.pendingChanges = [];

    // Deduplicate by type + filename and drop self-writes. Suppression
    // applies to ALL event types within the 500ms window: atomicWriteFile
    // generates rename events for the destination file (write-tmp →
    // rename-to-final), not just 'change'/'modify', so an event-type-scoped
    // suppression would miss self-writes and let them flicker the sidebar.
    // A user-initiated rename of the same path landing inside the 500ms
    // window is vanishingly unlikely; outside the window everything
    // propagates as normal.
    const seen = new Set<string>();
    const unique = changes.filter(c => {
      const key = `${c.type}:${c.filename}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (this.isSuppressed(c.filename)) return false;
      return true;
    });

    const exists = (relPath: string): boolean => {
      try {
        statSync(join(this.vaultPath, relPath));
        return true;
      } catch {
        return false;
      }
    };
    const sizeOf = (relPath: string): number | null => {
      const key = vaultPath(relPath);
      try {
        const sz = statSync(join(this.vaultPath, relPath)).size;
        this.lastKnownSizes.set(key, sz);
        return sz;
      } catch {
        // File gone — fall back to whatever size we saw last.
        const cached = this.lastKnownSizes.get(key);
        return cached ?? null;
      }
    };
    // Content-hash probe for the cross-basename rename pass. For a present
    // file under the ceiling, hash it and cache the digest; for a missing
    // file (the now-gone old path) return whatever we cached when it was last
    // seen. Anything else returns null so the correlator's hash-required
    // branch refuses to pair (defensive — better to emit delete+create than a
    // false-positive rename).
    //
    // `hashFileForRename` hashes the WHOLE file, identical to the
    // reconcile-walk seed, so a seeded digest matches an on-demand one.
    //
    // Async reads behind a 5-concurrent semaphore, so a burst (a recursive
    // rename arriving as N missing + N present) can't block the main thread
    // or saturate the libuv pool.
    const HASH_CONCURRENCY = 5;
    let inflightHashes = 0;
    const hashQueue: Array<() => void> = [];
    const acquireHashSlot = (): Promise<void> => new Promise((resolve) => {
      if (inflightHashes < HASH_CONCURRENCY) {
        inflightHashes += 1;
        resolve();
      } else {
        hashQueue.push(() => {
          inflightHashes += 1;
          resolve();
        });
      }
    });
    const releaseHashSlot = (): void => {
      inflightHashes -= 1;
      const next = hashQueue.shift();
      if (next) next();
    };
    const hashAsync = async (relPath: string): Promise<string | null> => {
      const key = vaultPath(relPath);
      try {
        const abs = join(this.vaultPath, relPath);
        const sz = statSync(abs).size;
        if (sz > WATCHER_HASH_MAX_BYTES) return null;
        await acquireHashSlot();
        try {
          const hash = await hashFileForRename(abs, sz);
          if (hash) this.lastKnownHashes.set(key, hash);
          return hash;
        } finally {
          releaseHashSlot();
        }
      } catch {
        const cached = this.lastKnownHashes.get(key);
        return cached ?? null;
      }
    };
    const { filtered, renames, conflicts } = await correlateRenames(unique, exists, sizeOf, hashAsync, undefined, knownHostsFor(this.vaultPath));
    // Re-check after the only await: a vault swap inside the hash-probe
    // window must not send the OLD vault's events — the renderer's rename
    // queue captures vault identity at ARRIVAL, so a late send would drive
    // the rename cascade against the NEW vault's same-named files.
    if (this.aborted) return;
    announceSyncConflicts(this.vaultPath, unique, exists, conflicts); // sync conflict forks
    // Move cached sizes + hashes onto the new path so a future delete of
    // the new path can still resolve, and drop the old-path entries.
    for (const r of renames) {
      const oldKey = vaultPath(r.oldPath);
      const newKey = vaultPath(r.newPath);
      const cachedSize = this.lastKnownSizes.get(oldKey);
      this.lastKnownSizes.delete(oldKey);
      if (cachedSize !== undefined && !this.lastKnownSizes.has(newKey)) {
        this.lastKnownSizes.set(newKey, cachedSize);
      }
      const cachedHash = this.lastKnownHashes.get(oldKey);
      this.lastKnownHashes.delete(oldKey);
      if (cachedHash !== undefined && !this.lastKnownHashes.has(newKey)) {
        this.lastKnownHashes.set(newKey, cachedHash);
      }
    }

    if (filtered.length === 0 && renames.length === 0) return;

    // `vault:tree-updated` triggers a full refreshTree() in the renderer,
    // which replaces the fileTree $state with a new array reference and
    // forces Svelte to re-render every sidebar item — visible as a flicker.
    // Only the structural events (create/delete/move = eventType 'rename'
    // on most platforms) actually change what's IN the tree. Content-only
    // changes ('change'/'modify') don't add or remove files, so the tree
    // doesn't need refreshing. correlateRenames-produced renames are by
    // definition structural.
    const treeChanged = renames.length > 0
      || filtered.some(c => c.eventType === 'rename');

    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (filtered.length > 0) {
        win.webContents.send('vault:files-changed', filtered);
      }
      for (const r of renames) {
        win.webContents.send('vault:file-renamed', r);
      }
      if (treeChanged) {
        win.webContents.send('vault:tree-updated');
      }
    }
  }
}

