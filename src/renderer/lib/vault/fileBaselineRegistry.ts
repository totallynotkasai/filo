/**
 * fileBaselineRegistry — per-path baseline (mtime + size) tracker for
 * pre-write external-edit detection.
 *
 * Records the mtime AND byte size of every file the renderer is "aware
 * of" — populated at hydrate time (after a fresh read) and refreshed on
 * every successful self-write. Writers consult `getBaseline(path)`
 * immediately before committing bytes to disk: if the on-disk mtime OR
 * size differs from the baseline, an external editor (Obsidian sync,
 * `git checkout`, VSCode) landed an edit in the gap. The writer then
 * routes through the `promptExternalEditOnSync` Reload / Keep-local
 * prompt instead of silently clobbering the external bytes.
 *
 * The same (mtime, size) we wrote = our own echo (ignore); a different
 * mtime OR size = real external edit (surface). Unlike a time-windowed
 * suppression, this never swallows a legitimate external edit.
 *
 * Why size as well as mtime: on coarse-mtime filesystems (FAT32 / exFAT,
 * many SMB/NFS shares, some cloud-sync mounts) two writes that land in
 * the same clock second share an mtime, so a pure mtime check would let
 * an in-app save silently clobber a concurrent external edit. A real
 * content edit almost always changes the byte length too, so comparing
 * size closes that hole. The one residual is a same-size, same-second
 * edit (e.g. a single-character swap on a coarse-mtime volume) — rare
 * enough to defer; upgrade this tuple to a content hash if it ever
 * proves real. The watcher's reconcile pass already hashes, so this
 * brings the writer-side guard closer to parity with it.
 *
 * Keys are normalised to forward-slash, leading-slash-stripped, and
 * case-folded on case-insensitive filesystems (NTFS / APFS) so an
 * `Notes.md` baseline matches a `notes.md` lookup.
 */

import { stripLeadingSlash, toPosix } from '../utils/path';
import { registerPathRenamable } from './renamePathKeys';

function detectCaseInsensitiveFs(): boolean {
  const proc = (globalThis as { process?: { platform?: unknown } }).process;
  if (proc && typeof proc.platform === 'string') {
    return proc.platform === 'win32' || proc.platform === 'darwin';
  }
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    return /Windows|Mac OS X|Macintosh/i.test(navigator.userAgent);
  }
  return false;
}
const CASE_INSENSITIVE_FS = detectCaseInsensitiveFs();

function normaliseKey(path: string): string {
  const slash = stripLeadingSlash(toPosix(path));
  return CASE_INSENSITIVE_FS ? slash.toLowerCase() : slash;
}

/**
 * A file's on-disk identity at the moment we last knew it: modification
 * time plus byte size. A mismatch on EITHER field versus a fresh stat
 * means an external writer touched the file since the baseline was taken.
 */
export interface FileBaseline {
  mtimeMs: number;
  size: number;
  /**
   * The exact bytes last CONFIRMED on disk for this baseline
   * (a hydrate read, or a post-write read-back that matched), when small enough
   * to keep (callers pass it only under the 1 MB read-back threshold). Lets the
   * gateway skip a write whose assembled bytes are identical. Any re-stamp
   * WITHOUT text (external reload, Keep-local re-anchor, a large note) drops it,
   * so a stale copy can never justify a skip. Roughly doubles memory for
   * hydrated notes under 1 MB — accepted.
   */
  text?: string;
}

/** Vault-relative path -> last-observed (mtime, size) baseline. */
// allow-module-state: reset via resetAllBaselines called from markdownFileWriter's pre-swap handler (cancelAllMarkdownWrites)
const baselines = new Map<string, FileBaseline>();

/**
 * Transfer the baseline from `oldRel` to `newRel` so a
 * post-rename body write doesn't drift-fail against a phantom baseline
 * still keyed under the OLD path. Also covers descendants when a folder
 * was renamed: every baseline keyed under `oldRel + '/'` re-keys to
 * `newRel + '/'`. Registered with `renameAllPathKeys` below so rename
 * cascades pick it up automatically.
 */
export function renameBaselinePath(oldRel: string, newRel: string): void {
  if (!oldRel || !newRel || oldRel === newRel) return;
  const oldKey = normaliseKey(oldRel);
  const newKey = normaliseKey(newRel);
  if (oldKey === newKey) return;
  const exact = baselines.get(oldKey);
  if (exact !== undefined) {
    baselines.delete(oldKey);
    baselines.set(newKey, exact);
  }
  // Folder-prefix sweep — re-key every descendant.
  const oldChildPrefix = oldKey + '/';
  const newChildPrefix = newKey + '/';
  const transfers: Array<[string, FileBaseline]> = [];
  for (const [key, value] of baselines) {
    if (key.startsWith(oldChildPrefix)) {
      transfers.push([newChildPrefix + key.slice(oldChildPrefix.length), value]);
      baselines.delete(key);
    }
  }
  for (const [k, v] of transfers) baselines.set(k, v);
}

/**
 * True when a fresh stat diverges from the recorded baseline — i.e. an
 * external edit landed since the baseline was captured. Centralised here
 * so the three writer-side drift checks (markdown / board / config) share
 * one definition of "drifted" and a future upgrade to a content hash is a
 * single-site change. Compares mtime OR size: either changing is drift.
 */
export function hasBaselineDrifted(
  baseline: FileBaseline,
  stat: { mtimeMs: number; size: number },
): boolean {
  return stat.mtimeMs !== baseline.mtimeMs || stat.size !== baseline.size;
}

/**
 * Stamps `path`'s baseline (mtime + size). Called from:
 *   - hydrate paths (after a fresh `vault:read-file-text`, which returns
 *     both mtime and size)
 *   - successful self-write completion (post-write `vault:stat`)
 *   - the Reload branch of `promptExternalEditOnSync` (after the
 *     renderer's in-memory copy was replaced by the on-disk version)
 *
 * Idempotent — re-stamping an existing entry just overwrites the value.
 * No-op when `path` is empty or either `mtimeMs` / `size` is not a finite
 * number (the caller's stat failed); the next successful stat will
 * populate a complete baseline.
 */
export function noteBaseline(
  path: string,
  mtimeMs: number | undefined | null,
  size: number | undefined | null,
  text?: string,
): void {
  if (!path) return;
  if (mtimeMs === undefined || mtimeMs === null || !Number.isFinite(mtimeMs)) return;
  // Require size too — a half-populated baseline (mtime but no size) would
  // silently weaken the drift check back to mtime-only for this entry. If
  // the caller's stat didn't yield a finite size, skip seeding; the next
  // successful stat will populate a complete baseline.
  if (size === undefined || size === null || !Number.isFinite(size)) return;
  const key = normaliseKey(path);
  if (!key) return;
  // REPLACES the entry: a re-stamp without `text` drops any previous text.
  baselines.set(key, text === undefined ? { mtimeMs, size } : { mtimeMs, size, text });
}

/**
 * Returns the recorded baseline (mtime + size) for `path`, or `undefined`
 * if none has been stamped yet. Writers pass a fresh stat to
 * `hasBaselineDrifted` against this value: a mismatch on either field
 * indicates an external edit landed since the baseline was captured.
 *
 * Returning `undefined` for an unstamped path is treated as "no baseline
 * yet, proceed without drift check" (the first write to a fresh file has no
 * comparison anchor).
 */
export function getBaseline(path: string): FileBaseline | undefined {
  if (!path) return undefined;
  return baselines.get(normaliseKey(path));
}

/**
 * Drops `path`'s baseline. Called from rename / delete propagation paths
 * so a stale baseline doesn't pin to an entry the file no longer occupies.
 * Mirror to `noteBaseline(newPath, mtime, size)` on the rename side so the new
 * path inherits the freshly-renamed baseline.
 */
export function clearBaseline(path: string): void {
  if (!path) return;
  baselines.delete(normaliseKey(path));
}

/**
 * Post-write baseline refresh: stamps a fresh baseline when the post-write
 * stat supplies a usable mtime + size, and otherwise KEEPS the prior baseline
 * untouched.
 *
 * Used by every successful self-write site (`markdownFileWriter`,
 * `boardWriteScheduler`, `configWriteScheduler`) so the next write's pre-write
 * drift check compares against the bytes we just wrote, not the pre-write
 * state.
 *
 * On an unusable stat (the IPC threw, returned no fields, or returned NaN)
 * this KEEPS the prior baseline. Clearing it would disable the next write's
 * drift check and open a silent-overwrite window; keeping it risks at worst a
 * spurious Reload / Keep-local prompt. Post-write stat failures are rare (AV
 * scanner, SMB latency), so the false-positive cost is bounded.
 */
export function refreshBaselineAfterWrite(
  path: string,
  mtimeMs: number | undefined | null,
  size: number | undefined | null,
  text?: string,
): void {
  if (!path) return;
  if (
    typeof mtimeMs === 'number' &&
    Number.isFinite(mtimeMs) &&
    typeof size === 'number' &&
    Number.isFinite(size)
  ) {
    noteBaseline(path, mtimeMs, size, text);
    return;
  }
  // Else: keep the prior baseline. Deliberately NO clearBaseline call.
  // But drop its confirmed TEXT: a write was issued whose bytes
  // we could not confirm, so the old text no longer proves what disk holds (on a
  // coarse-mtime volume a same-size write could otherwise leave mtime+size
  // "unchanged" and let a later write back to the old bytes be skipped).
  const key = normaliseKey(path);
  const prior = baselines.get(key);
  if (prior?.text !== undefined) baselines.set(key, { mtimeMs: prior.mtimeMs, size: prior.size });
}

/**
 * Wipes every baseline entry. Routed through the vault-swap reset hook
 * so a baseline captured against the outgoing vault can't suppress a
 * legitimate drift check against a same-named file in the new vault.
 */
export function resetAllBaselines(): void {
  baselines.clear();
}

/**
 * Dev-only runtime tripwire: every eagerly-loaded file must have a drift
 * baseline, or its pre-write drift check silently no-ops.
 *
 * Called right after a vault commits, this `console.warn`s any loaded path
 * missing a baseline. It never throws: a missing baseline degrades to an
 * unguarded write, never a crash, so production skips the check entirely.
 *
 * Scope: the EAGERLY-seeded sinks — boards and the four `.filo/` configs the
 * writer scheduler drift-checks (`defaults.json`, `app.json`,
 * `appearance.json`, `workspace.json`). `.md` baselines are seeded lazily on
 * hydrate via `readMarkdownForHydrate` (enforced by a CI gate), so none are
 * expected at commit time.
 *
 * The empty-registry short-circuit keeps unit tests that install boards
 * without going through the real stat-backed load path from tripping the
 * warn — a real load always seeds at least one baseline.
 */
export function assertBaselinesSeeded(paths: Iterable<string>, label: string): void {
  if (!import.meta.env.DEV) return;
  if (baselines.size === 0) return;
  const missing: string[] = [];
  for (const p of paths) {
    if (getBaseline(p) === undefined) missing.push(p);
  }
  if (missing.length === 0) return;
  console.warn(
    `[fileBaselineRegistry] ${missing.length} ${label}(s) loaded without a drift baseline — ` +
      `pre-write external-edit detection is inert for them (F1 regression?): ${missing.join(', ')}`,
  );
}

// Every rename cascade calls renameAllPathKeys(oldRel,
// newRel) once, which fires this sweep. Without it, a post-rename body
// write drift-fails against a phantom baseline still keyed under the
// OLD path.
registerPathRenamable('fileBaselineRegistry', renameBaselinePath);

/**
 * Test-only — exposes the internal Map size so unit tests can assert
 * the registry was populated / drained as expected. Production code
 * should never need this.
 */
export function __baselineCountForTests(): number {
  return baselines.size;
}

/**
 * Test-only — wipes every entry. Production callers route through
 * `resetAllBaselines` (named for the vault-swap intent).
 */
export function __resetBaselinesForTests(): void {
  baselines.clear();
}
