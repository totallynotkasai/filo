import { watch, type FSWatcher, statSync, promises as fsPromises } from 'fs';
import { BrowserWindow } from 'electron';
import { extname, join } from 'path';
import { createHash } from 'crypto';
import { correlateRenames } from './renameCorrelation';
import { logMainError } from '../utils/mainLogger';
import { toPosix, relativePosix } from '../utils/pathHelpers';
import { vaultPath, type VaultPath } from '../../shared/vaultPath';
import type { FileChangeEvent, FileChangeType } from './fileWatcherTypes';
import {
  WatcherSupervisor,
  type WatcherState,
} from './watcherSupervisor';

export { correlateRenames } from './renameCorrelation';
export type { FileChangeEvent, FileChangeType } from './fileWatcherTypes';
export type { WatcherState, WatcherStatePayload } from './watcherSupervisor';

/**
 * Phase 31 B2.3 — per-segment matching rather than `string.includes`. The
 * legacy substring check matched `Article on Thumbs.db.md` because the
 * basename contains the literal "Thumbs.db" — which is a real-world title
 * pattern users have hit. We now split the relative path by `/` and apply
 * one rule per segment.
 *
 *  - `exactNames`: a segment whose entire string equals the pattern (e.g.
 *    `Thumbs.db`, `.DS_Store`). `Article on Thumbs.db.md` is no longer
 *    swallowed because the *basename* segment isn't exactly `Thumbs.db`.
 *  - `folderNames`: an INTERIOR segment (any but the last) matching the
 *    pattern (e.g. `node_modules`, `.git`). The last segment isn't a
 *    folder by definition, so a file literally named `node_modules` at
 *    the vault root still reaches the classifier — desired.
 *  - `suffixes`: the final segment ends with this string (e.g. `.tmp`,
 *    `.bak`). Editor-temp files plus the atomicWriteFile temp suffix all
 *    end in `.tmp`/`.bak`, so this catches them regardless of basename.
 *  - `prefixedPaths`: full path starts with this prefix (e.g.
 *    `.filo/cache/`). Lets us ignore an internal cache subtree without
 *    spuriously matching a user-created `cache` folder elsewhere.
 */
const IGNORE_RULES = {
  exactNames: new Set<string>(['Thumbs.db', '.DS_Store', 'desktop.ini']),
  folderNames: new Set<string>(['node_modules', '.git']),
  suffixes: ['.tmp', '.bak'] as const,
  prefixedPaths: ['.filo/cache/'] as const,
};

function shouldIgnorePath(normalized: string): boolean {
  for (const prefix of IGNORE_RULES.prefixedPaths) {
    if (normalized.startsWith(prefix)) return true;
  }
  const segments = normalized.split('/');
  const lastIdx = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i === lastIdx) {
      if (IGNORE_RULES.exactNames.has(segment)) return true;
      for (const suffix of IGNORE_RULES.suffixes) {
        if (segment.endsWith(suffix)) return true;
      }
    } else {
      if (IGNORE_RULES.folderNames.has(segment)) return true;
    }
  }
  return false;
}

/**
 * File extensions that should be classified as `'attachment'` regardless of
 * the folder they live in. Phase 19 S4 — before this set existed, only files
 * under `attachments/` participated in rename correlation. An OS-level move
 * of `hero.jpg` from the vault root to `media/` produced two `'tree'` events
 * which the correlator ignores, so every tile pointing at the file silently
 * dangled.
 *
 * Keeps the same coverage as `mime.getMimeType`'s media types — anything the
 * media-tile reader could serve is something a user might place outside
 * `attachments/` and expect rename propagation for.
 */
const MEDIA_EXTENSIONS = new Set<string>([
  // Images (Phase 31 C3.8 adds .heic/.heif/.avif — modern Apple + browser
  // capture formats users drag in from Photos.app and screenshots)
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
  '.heic', '.heif', '.avif',
  // Video
  '.mp4', '.webm', '.ogv', '.mov',
  // Audio (Phase 31 C3.8 adds .opus, .mid, .midi — Opus is the modern
  // WebM Opus container, MIDI for music workflows)
  '.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a',
  '.opus', '.mid', '.midi',
  // Documents the file-tile / link-tile expects to open
  '.pdf',
]);

interface ReconcileEntry {
  mtimeMs: number;
  size: number;
  /**
   * Phase 31 A6.5 — short FNV-1a 32-bit hash of the first 4 KB of the
   * file (or the full content for smaller files). Catches the FAT/SMB
   * case where mtime granularity is 2 seconds and two writes within the
   * same second leave both stat fields unchanged. `undefined` for
   * non-.md files (we don't hash media for cost reasons) and for files
   * we couldn't open during the walk.
   */
  hash?: number;
}

/**
 * Phase 31 A6.5 — FNV-1a 32-bit hash over a Buffer slice. Used during
 * reconciliation to detect "same mtime + same size but different bytes"
 * mid-second rewrites that fs.stat alone misses. 4 KB is enough to vary
 * for almost every realistic .md edit and keeps the per-file cost in
 * the microseconds.
 */
function fnv1a32(buf: Buffer): number {
  let hash = 0x811c9dc5;
  const max = Math.min(buf.length, 4096);
  for (let i = 0; i < max; i++) {
    hash ^= buf[i];
    // FNV prime 16777619, kept inside int32 via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * How long between reconciliation passes. The walker has to stat every file
 * under the vault, so we can't run it too aggressively. 30s strikes a balance
 * between catching drift quickly enough for the user to notice and not
 * burning I/O on quiet vaults. Phase 19 S2.
 */
const RECONCILE_INTERVAL_MS = 30_000;

// Phase 3 / 3.1 — supervisor state machine + reopen backoff schedule
// live in src/main/services/watcherSupervisor.ts. `FileWatcher` owns one
// `WatcherSupervisor` instance per vault and delegates state-machine
// concerns (broadcast state, schedule retry, clear retry) to it. See
// the supervisor module for the full state diagram + retry semantics.

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
 * watcher. Phase 19 S2.
 */
/**
 * Phase 4 — every key under `suppressedPaths` / `suppressedPrefixes` /
 * `lastKnownSizes` / `lastKnownHashes` is routed through the shared
 * `vaultPath()` constructor. The OS-fork that used to live here
 * (`CASE_INSENSITIVE_FS` + `normaliseSuppressionKey`) is gone — the
 * `VaultPath` brand collapses casing unconditionally so suppression and
 * size/hash caches agree on key identity on every platform. The trade-off
 * is the same one accepted across the codebase: a hypothetical Linux vault
 * with both `Notes.md` and `notes.md` as distinct files would conflate
 * them in the suppression map (just as it would in `fileTags`,
 * `recentSelfWrites`, etc.).
 */

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges: FileChangeEvent[] = [];
  private readonly debounceMs = 300;

  /** Vault-relative path -> expiry timestamp (ms since epoch). */
  private suppressedPaths = new Map<VaultPath, number>();

  /**
   * Phase C / C.4 — vault-relative directory prefix -> expiry. Set by
   * {@link suppressTree} when the renderer issues a recursive folder
   * delete via `vault:delete`. The watcher emits a separate event for
   * every descendant `unlink` / `rename` that follows; without a
   * prefix-aware suppressor each one would flow into
   * `handleExternalMarkdownChanges` and a dirty editor for any file in
   * the deleted folder would briefly see the "deleted externally"
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
   * Phase 31 A4.3 — per-path content-hash cache. Populated lazily when a
   * file appears in a watcher event AND is small enough to hash cheaply
   * (see `HASH_CACHE_MAX_BYTES`). Used by `correlateRenames`'s
   * cross-basename pass to refuse pairing two files that share a size
   * but not their content.
   */
  private lastKnownHashes = new Map<VaultPath, string>();

  /**
   * Snapshot of the vault filesystem from the last successful reconciliation
   * pass. Keyed by vault-relative path (with forward slashes). `null` before
   * the first pass — the very first reconciliation treats every file as
   * "newly seen" and seeds the snapshot without firing any events.
   *
   * Phase 19 S2.
   */
  private reconcileSnapshot: Map<string, ReconcileEntry> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileInFlight = false;

  /**
   * Phase 3 / 3.1 — promise handle to the in-flight `reconcileNow()` walk
   * (or `null` if no walk is running). `stop()` awaits this before returning
   * so a vault swap cannot leave a partial walk emitting `vault:files-changed`
   * events for the OLD vault on the NEW vault's window. Without it, a 5 s
   * walk in progress at the moment of swap would land its synthesised events
   * after the new `FileWatcher` has been constructed — surfacing the prior
   * vault's paths in the renderer's external-edit pipeline.
   */
  private reconcileInFlightPromise: Promise<void> | null = null;

  /**
   * Phase 3 / 3.1 — set by `stop()`. Once true, every emit path
   * (`notifyRenderers`, `scheduleNotify`, the reconcile diff loop) short-
   * circuits so any work that races past the `reconcileInFlight` check
   * cannot fire late events on a torn-down watcher.
   */
  private aborted = false;

  /**
   * Phase 3 / 3.1 — supervisor state machine. Owns the reopen retry
   * schedule + `vault:watcher-state` broadcasts. See `watcherSupervisor.ts`
   * for the full state diagram.
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
   * Phase 19 S3 — when the same path is suppressed twice in close
   * succession (e.g. board.save's pre + post suppress, or two atomic-write
   * cycles in flight) the later call must EXTEND the window rather than
   * silently shorten it. The previous Map.set behaviour would let a
   * `suppress(path, 1000)` follow a `suppress(path, 2000)` 200ms later and
   * shrink the effective expiry by ~800ms, allowing the rename event to
   * slip past suppression on slow disks.
   */
  suppress(relativePath: string, durationMs: number = 500): void {
    // Phase 4 — `vaultPath()` brands + case-folds + slash-normalises the key
    // so renderer-side suppression of `Notes.md` matches an OS-emitted
    // watcher event with `notes.md` casing.
    const normalized = vaultPath(relativePath);
    if (!normalized) return;
    const next = Date.now() + durationMs;
    const current = this.suppressedPaths.get(normalized) ?? 0;
    this.suppressedPaths.set(normalized, Math.max(current, next));
  }

  /**
   * Phase C / C.4 — suppress every watcher event whose path equals OR
   * starts under `relativePath/` for `durationMs`. Called immediately
   * before a recursive folder delete so the cascade of per-descendant
   * unlink events doesn't surface as N "deleted externally" prompts to
   * any dirty editor that happened to be open on a file under the folder.
   *
   * Uses the extend-only semantics established by Phase 19 S3 — a
   * concurrent suppression on the same prefix only ever lengthens the
   * window.
   */
  suppressTree(relativePath: string, durationMs: number = 2000): void {
    // Phase 4 — `vaultPath()` case-folds + slash-normalises so the
    // prefix sweep in `isSuppressed` matches OS-emitted events whose
    // path casing differs from the renderer-supplied folder path. The
    // trailing-slash strip keeps the prefix-collision guard intact
    // (Phase C / C.4) — the trailing slash is re-added below.
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
    // Phase 4 — symmetric `vaultPath()` so a watcher event reported with
    // a different casing than the renderer's suppression call still
    // matches its entry. Without the brand, an OS-emitted `notes.md`
    // event on Windows misses a renderer-side `suppress('Notes.md')`
    // and the rename event leaks into `handleExternalMarkdownChanges`.
    const normalized = vaultPath(relativePath);
    const expiry = this.suppressedPaths.get(normalized);
    if (expiry !== undefined) {
      if (Date.now() > expiry) {
        this.suppressedPaths.delete(normalized);
      } else {
        return true;
      }
    }
    // Phase C / C.4 — prefix sweep: check every active tree-suppress
    // entry. The map is typically tiny (one entry per in-flight folder
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
   * Sprint A / A7 — broadcast a `vault:watcher-failed` event to every
   * BrowserWindow so the renderer can toast "external-edit watcher failed,
   * edits made in other apps won't auto-refresh". Centralised so the
   * synchronous fs.watch() exception path AND the async 'error' event
   * path share one notification shape.
   *
   * Phase 3 / 3.1 — `vault:watcher-failed` remains for compatibility with
   * the renderer toast plus the supervisor-aware `vault:watcher-state`
   * `reconnecting` event broadcasts the structured payload. Both fire
   * together so older listeners keep working.
   */
  private notifyWatcherFailed(err: unknown): void {
    if (this.aborted) return;
    logMainError('fileWatcher.error', err);
    const reason = err instanceof Error ? err.message : String(err);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('vault:watcher-failed', { vaultPath: this.vaultPath, reason });
    }
  }

  /** Phase 3 / 3.1 — test-only state introspection. Delegates to supervisor. */
  getState(): WatcherState {
    return this.supervisor.getState();
  }

  /** Phase 3 / 3.1 — test-only attempt introspection. Delegates to supervisor. */
  getRetryAttempt(): number {
    return this.supervisor.getRetryAttempt();
  }

  /**
   * Phase 3 / 3.2 — test-only access to the granular path classifier.
   * The walker normally skips `.filo/` entirely, so the only production
   * path for `config-tags` / `config-theme` / `config-template`
   * classifications is the live `fs.watch` callback. That makes the
   * classifier hard to exercise deterministically in unit tests; this
   * public method gives the suite a direct probe without weakening the
   * encapsulation in production code.
   */
  classifyForTests(relativePath: string): FileChangeType {
    return this.classifyChange(relativePath);
  }

  start(): void {
    if (this.watcher) return;
    if (this.aborted) return;

    this.openLiveWatcher();

    // Phase 19 S2 — seed the reconciliation snapshot in the background. The
    // very first pass treats every file as "newly seen" so we don't fire a
    // create event for every existing vault file. Once seeded, the periodic
    // tick fires synthesised events for any drift the OS-level watcher
    // missed. The reconcile timer is intentionally independent of the live
    // watcher state — Phase 3 / 3.1 keeps it running during `reconnecting`
    // so external edits are still surfaced (at the slower 30 s cadence)
    // until the live handle comes back.
    void this.reconcileNow({ seedOnly: true });
    this.reconcileTimer = setInterval(() => {
      void this.reconcileNow({ seedOnly: false });
    }, RECONCILE_INTERVAL_MS);
  }

  /**
   * Phase 3 / 3.1 — opens (or re-opens) the live `fs.watch` handle and
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
        // Phase 3 / 3.1 — drop OS-level events that fired between the OS
        // closing the underlying handle and our `watcher = null` clearing.
        // Without this a vault swap can briefly funnel events for the
        // OUTGOING vault into the pending queue of the watcher that's
        // about to be discarded.
        if (this.aborted) return;

        const normalized = toPosix(filename);

        if (shouldIgnorePath(normalized)) return;

        const changeType = this.classifyChange(normalized);
        this.pendingChanges.push({
          type: changeType,
          filename: normalized,
          eventType: eventType || 'change',
        });

        this.scheduleNotify();
      });
      // Sprint A / A7 + Phase 3 / 3.1 — fs.watch emits async 'error' events
      // when the OS watch handle is invalidated mid-life. Hand off to the
      // supervisor which transitions to `reconnecting` and schedules a
      // retry with exponential backoff.
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
   * Phase 3 / 3.1 — central error path for the live watcher. Closes the
   * dead handle, emits the legacy `vault:watcher-failed` event for
   * existing renderer listeners, and hands the supervisor the state
   * transition + retry scheduling.
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
   * Phase 3 / 3.1 — async tear-down. Sets `aborted` first so any code path
   * that races past the in-flight checks (notifyRenderers, scheduleNotify,
   * reconcile diff loop) short-circuits. Then awaits the in-flight reconcile
   * walk so the new vault's watcher can be constructed without the prior
   * walk landing late `vault:files-changed` events under the new vault.
   *
   * The pre-existing synchronous teardown work (clear timers, close the OS
   * watcher, drop tracking maps) runs after the await — even when the walk
   * throws — so the cleanup is unconditional.
   */
  async stop(): Promise<void> {
    this.aborted = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    // Phase 3 / 3.1 — supervisor.shutdown() cancels any pending reopen
    // retry timer and broadcasts `suspended` exactly once. The
    // `aborted` check inside `openLiveWatcher` would refuse a stale
    // retry anyway, but cancelling the timer keeps the process clean.
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
    this.pendingChanges = [];
    this.suppressedPaths.clear();
    this.suppressedPrefixes.clear();
    this.lastKnownSizes.clear();
    this.lastKnownHashes.clear();
    this.reconcileSnapshot = null;
    this.reconcileInFlight = false;
    this.reconcileInFlightPromise = null;
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
   * Phase 19 S2 — surfaces `vault:watcher-failed` if the walker errors
   * after the initial seed (signals a vault root that has gone unreadable),
   * giving the user a clear "your edits in other apps may stop showing up"
   * toast rather than silent dead-watcher state.
   */
  async reconcileNow(options: { seedOnly?: boolean } = {}): Promise<void> {
    if (this.reconcileInFlight) return;
    if (this.aborted) return;
    this.reconcileInFlight = true;
    // Phase 3 / 3.1 — publish the in-flight promise so `stop()` can await
    // it. The IIFE captures `this` synchronously and the assignment
    // happens before any await suspension, so a `stop()` that fires in
    // the very same tick as the start will still see the handle.
    const promise = (async () => {
      try {
        const current = await this.walkVault();
        if (current === null) return;
        if (this.aborted) return;
        const previous = this.reconcileSnapshot;
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
              type: this.classifyChange(path),
              filename: path,
              eventType: 'rename',
            });
          } else if (
            prior.mtimeMs !== entry.mtimeMs
            || prior.size !== entry.size
            // Phase 31 A6.5 — hash differs even with identical mtime+size.
            // Catches FAT/SMB rewrite-within-same-second cases where stat
            // alone would call the change invisible.
            || (prior.hash !== undefined && entry.hash !== undefined && prior.hash !== entry.hash)
          ) {
            synthesised.push({
              type: this.classifyChange(path),
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
            type: this.classifyChange(path),
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
    return out;
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
        // .filo is owned by Filo; skip the whole subtree from the
        // reconciliation pass. Cache, recovery, viewports rewrite often
        // and would produce constant synthesised events for no benefit.
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
          // Phase 31 A6.5 — hash `.md` files so reconcile can detect
          // mid-second rewrites on filesystems with second-resolution
          // mtime (FAT, SMB, some NFS configs). Capped at 4 KB inside
          // fnv1a32 so multi-MB notes don't slow the walker.
          //
          // Sprint B / B10 — also seed the SHA-1 prefix hash that the
          // cross-basename correlator consumes. Reading the head once
          // and feeding both hashes off the same buffer keeps the walk
          // cost at one fs.open per .md while ensuring the cache is
          // populated before the first cross-basename rename event for
          // the file. Without the seed, the first such event for any
          // file always failed to pair (hashAsync had no cached value
          // for the now-missing source).
          if (rel.toLowerCase().endsWith('.md')) {
            try {
              const fd = await fsPromises.open(full, 'r');
              try {
                const head = Buffer.alloc(4096);
                const { bytesRead } = await fd.read(head, 0, 4096, 0);
                const slice = head.slice(0, bytesRead);
                hash = fnv1a32(slice);
                this.lastKnownHashes.set(
                  vaultPath(rel),
                  createHash('sha1').update(slice).digest('hex'),
                );
              } finally {
                await fd.close();
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

  private classifyChange(relativePath: string): FileChangeType {
    if (relativePath.startsWith('.filo/')) {
      // Phase 3 / 3.2 — granular `.filo/` classification. The renderer's
      // exhaustive dispatcher then routes each kind to its dedicated
      // reconciler (`tagsJsonReconciler`, `themeJsonReconciler`, etc.).
      // Anything that doesn't match a granular subtype keeps the legacy
      // `config` classification so dispatch can no-op cleanly.
      if (relativePath === '.filo/tags.json') return 'config-tags';
      if (relativePath.startsWith('.filo/themes/')) return 'config-theme';
      if (relativePath.startsWith('.filo/templates/')) return 'config-template';
      return 'config';
    }

    if (relativePath.endsWith('.board.json')) {
      return 'board';
    }

    const lowerExt = extname(relativePath).toLowerCase();

    // Phase 31 B2.6 — treat `.markdown` the same as `.md`. The renderer's
    // `isMarkdownExtension` (src/renderer/lib/vault/extension.ts) accepts
    // both spellings for tile creation; classifyChange used to accept only
    // `.md`, which meant the watcher missed external edits to `.markdown`
    // files entirely. Reconciliation, conflict resolution, and the bulk
    // toast aggregator all hang off the `document` classification.
    //
    // Phase 7 (IMPLEMENTATION_PLAN_2026-05-27) — promote `.txt` to
    // `'document'` so external `.txt` ↔ `.md` renames in a text editor
    // pair through `correlateRenames` (already accepts both via
    // `TEXT_LIKE_EXTENSIONS`). Without this promotion `.txt` events were
    // classified as `'tree'` and skipped the same-basename / cross-basename
    // correlation passes, so a `Notes.txt` → `Notes.md` rename surfaced as
    // a delete + create and broke every tile pointing at the file.
    if (lowerExt === '.md' || lowerExt === '.markdown' || lowerExt === '.txt') {
      return 'document';
    }

    // S4: media files participate in rename correlation whether they live
    // under `attachments/` or anywhere else in the vault. The legacy folder
    // prefix is kept as a fallback so a user-defined extension we haven't
    // listed (e.g. `.heic`) still classifies correctly when placed under
    // `attachments/`.
    if (MEDIA_EXTENSIONS.has(lowerExt) || relativePath.startsWith('attachments/')) {
      return 'attachment';
    }

    return 'tree';
  }

  private scheduleNotify(): void {
    // Phase 3 / 3.1 — refuse to arm a new debounce after `stop()` has
    // been called. The reconcile diff loop also checks `aborted` before
    // calling this, but the live watcher callback may have queued events
    // in the same tick stop() fired; this is the second guard.
    if (this.aborted) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      // Polish phase 1.4 — `notifyRenderers` is now async because the
      // cross-basename rename hash probe reads file bytes off the main
      // thread. The setTimeout callback is fire-and-forget; we attach
      // a `.catch` so an unexpected rejection is logged rather than
      // becoming an unhandled-promise warning.
      this.notifyRenderers().catch((err) => {
        logMainError('fileWatcher.notifyRenderers', err);
      });
    }, this.debounceMs);
  }

  private async notifyRenderers(): Promise<void> {
    // Phase 3 / 3.1 — final guard: even if a debounce armed before
    // `stop()` (clearTimeout in stop() should have cancelled it, but
    // defence-in-depth keeps the contract clear), no events should ever
    // be emitted from an aborted watcher.
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
    // Phase 31 A4.3 — content-hash probe for the cross-basename rename
    // pass. For present files smaller than HASH_CACHE_MAX_BYTES (10 MB),
    // hash the bytes and cache; for missing files, return whatever we
    // cached when the file was last seen. Anything else returns null so
    // the correlator's hash-required branch refuses to pair (defensive
    // — better to emit delete+create than a false-positive rename).
    const HASH_CACHE_MAX_BYTES = 10 * 1024 * 1024;
    // Sprint B / B10 — bytes hashed for the cross-basename probe and the
    // reconcile-walk seed. Must be identical at both call sites so the
    // cached digest from the walk matches the on-demand digest from the
    // correlator on first cross-basename event.
    const HASH_PROBE_BYTES = 4096;
    // Polish phase 1.4 — async hash read with a 5-concurrent semaphore.
    // The pre-fix `readFileSync` blocked the event loop for the duration
    // of every cross-basename hash probe, which on a 500-file vault with
    // multi-MB notes could pin the main thread for hundreds of ms and
    // back up every other IPC call. `fs.promises.readFile` runs the I/O
    // on the libuv thread pool; the semaphore caps concurrent reads at
    // 5 so a synthetic burst (e.g. a recursive directory rename arriving
    // as N missing + N present events in one tick) doesn't saturate the
    // pool and starve unrelated handlers.
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
        const sz = statSync(join(this.vaultPath, relPath)).size;
        if (sz > HASH_CACHE_MAX_BYTES) return null;
        await acquireHashSlot();
        try {
          // Sprint B / B10 — hash only the first HASH_PROBE_BYTES of the
          // file so the reconcile-walk seed (which uses the same prefix
          // hash) and the on-demand correlator hash use a single,
          // comparable digest format. Limits the probe cost to ~4 KB
          // per file on disk; SHA-1 over 4 KB still gives 160 bits of
          // identity, well above the cross-basename pair-uniqueness
          // requirements (single missing + single present per size+ext
          // bucket).
          const fd = await fsPromises.open(join(this.vaultPath, relPath), 'r');
          let hash: string;
          try {
            const head = Buffer.alloc(HASH_PROBE_BYTES);
            const { bytesRead } = await fd.read(head, 0, HASH_PROBE_BYTES, 0);
            hash = createHash('sha1').update(head.subarray(0, bytesRead)).digest('hex');
          } finally {
            await fd.close();
          }
          this.lastKnownHashes.set(key, hash);
          return hash;
        } finally {
          releaseHashSlot();
        }
      } catch {
        const cached = this.lastKnownHashes.get(key);
        return cached ?? null;
      }
    };
    const { filtered, renames } = await correlateRenames(unique, exists, sizeOf, hashAsync);
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

