import type { FileMetadata } from './vaultIndex';
import { valuesEqual } from './frontmatterEngine';

/**
 * Describes what to do with an external change to a file the app may be
 * watching. Callers dispatch based on `.action`:
 *
 *   - 'prompt-user'        → show a Reload/Keep-local toast for a dirty editor
 *                            or a dirty Properties popup (the reason
 *                            distinguishes the two so the toast can word
 *                            itself correctly)
 *   - 'reload-silently'    → safe to overwrite in-memory copy with disk
 *   - 'sync-frontmatter'   → only metadata changed; run frontmatterSync, no UI
 *   - 'partial-read-retry' → next snapshot looks like a mid-write truncated
 *                            read (external tool's truncate-then-rewrite caught
 *                            mid-flight); caller schedules a delayed re-read
 *                            instead of applying the bad data
 *   - 'ignore'             → change is irrelevant (not tracked / not indexed)
 */
export type ConflictAction =
  | { action: 'prompt-user'; reason: 'editor-dirty' | 'properties-popup-dirty' }
  | { action: 'reload-silently'; reason: 'editor-clean' }
  | { action: 'sync-frontmatter'; reason: 'frontmatter-only' | 'first-sight' }
  | { action: 'partial-read-retry'; reason: 'size-shrink' }
  | { action: 'ignore'; reason: string };

/**
 * Minimal contract for what the caller knows about an open editor. Keeping
 * this tiny keeps the resolver independent of the document store / TipTap.
 */
export interface EditorSnapshot {
  path: string;
  isDirty: boolean;
}

/**
 * Classifies an external change event. Decision rules:
 *
 *   1. If the file isn't currently open in an editor and the only change is
 *      frontmatter (heading + body text match the indexed version), return
 *      'sync-frontmatter' so the caller can silently reconcile tile caches
 *      without reloading anything.
 *
 *      EXCEPTION: when an open Properties popup is dirty against the same
 *      path (`propertiesPopupDirty`), the silent sync would clobber the
 *      popup's pending row edits. Route to 'prompt-user' with reason
 *      'properties-popup-dirty' so the caller surfaces a Reload/Keep-local
 *      toast covering the popup's state too.
 *
 *   2. If an editor is open and dirty, return 'prompt-user' — the UI layer
 *      should surface a Reload/Keep-local toast. Data loss is unacceptable
 *      without user consent.
 *
 *   3. If an editor is open and clean, return 'reload-silently' — there is
 *      nothing to lose by updating the in-memory copy from disk.
 *
 *   4. If this is the first sighting of the file (no previous metadata) and
 *      no editor is open, return 'sync-frontmatter' so the caller can still
 *      register the file's tags + apply its frontmatter to any pre-existing
 *      tile caches. Without this, a file dropped into the vault between
 *      sessions would silently miss the tag-registration sweep until its
 *      next edit.
 *
 *   5. Otherwise 'ignore' — nothing depends on this file in the current
 *      session.
 */
export function classifyExternalChange(params: {
  path: string;
  previousMetadata: FileMetadata | null;
  nextMetadata: FileMetadata | null;
  editor: EditorSnapshot | null;
  /**
   * True when an open Properties popup has unflushed row edits against
   * `path`. The caller (vaultExternalChanges) consults
   * `propertiesPopupTracker` and passes the bool in, keeping the classifier
   * free of store imports. Defaults to false.
   */
  propertiesPopupDirty?: boolean;
}): ConflictAction {
  const { previousMetadata, nextMetadata, editor } = params;
  const propertiesPopupDirty = params.propertiesPopupDirty ?? false;

  if (!nextMetadata) {
    // File disappeared or failed to parse; defer to the caller.
    return editor
      ? { action: 'prompt-user', reason: 'editor-dirty' }
      : { action: 'ignore', reason: 'file-missing' };
  }

  // Frontmatter-only changes are safe regardless of editor state — the
  // editor doesn't own frontmatter, so applying disk frontmatter into tile
  // caches never collides with in-progress body edits. Short-circuit before
  // the dirty/clean check so a dirty editor doesn't get a spurious
  // Reload/Keep-local toast when only metadata moved.
  //
  // When `previousMetadata` is null (first sighting of this file, or the
  // indexer hasn't seen it before), we cannot prove the body is unchanged
  // and fall through to the editor-state path — that's the safe default.
  if (previousMetadata && isBodyEquivalent(previousMetadata, nextMetadata)) {
    if (!frontmatterEqual(previousMetadata, nextMetadata)) {
      // Even a frontmatter-only delta can be a mid-write truncated read (the
      // FM block caught mid-rewrite while the body matches). Applying it would
      // push truncated frontmatter into tile caches / tags, so hold for a
      // delayed re-read on the raw-shrink + fresh-mtime signature.
      if (isLikelyPartialRead(previousMetadata, nextMetadata)) {
        return { action: 'partial-read-retry', reason: 'size-shrink' };
      }
      // The popup is the canonical frontmatter authority while
      // it's open + dirty. A silent sync here would clobber the popup's
      // pending row edits; force a user choice instead.
      if (propertiesPopupDirty) {
        return { action: 'prompt-user', reason: 'properties-popup-dirty' };
      }
      return { action: 'sync-frontmatter', reason: 'frontmatter-only' };
    }
    return { action: 'ignore', reason: 'noop-change' };
  }

  if (!editor) {
    // First sighting of a file we have no baseline for. Treat as a
    // frontmatter sync so the caller can register tags / apply frontmatter
    // to backed tiles. The body isn't relevant — no editor is open. If a
    // tile later loads this file it will hydrate fresh from disk.
    if (!previousMetadata) {
      return { action: 'sync-frontmatter', reason: 'first-sight' };
    }
    // The BODY changed and no editor owns this path. If the FRONTMATTER also
    // changed we must still sync it, or a closed-file Kanban card / Task row
    // keeps stale metadata (and computes field-edit inverses against it). The
    // body needs no action — the next tile load hydrates from disk. Same
    // partial-read guard as the editor branches.
    if (!frontmatterEqual(previousMetadata, nextMetadata)) {
      if (isLikelyPartialRead(previousMetadata, nextMetadata)) {
        return { action: 'partial-read-retry', reason: 'size-shrink' };
      }
      return { action: 'sync-frontmatter', reason: 'frontmatter-only' };
    }
    return { action: 'ignore', reason: 'no-editor-open' };
  }

  if (editor.isDirty) {
    return { action: 'prompt-user', reason: 'editor-dirty' };
  }

  // Guard against mid-write partial reads. An external tool
  // that does truncate-then-rewrite (or any non-atomic write on a slow disk)
  // can be caught mid-flight by the watcher; vaultIndex.applyChanges then
  // re-reads a truncated file and the classifier would otherwise hand that
  // empty/tiny body to a clean editor as `reload-silently`, silently
  // destroying the user's view. Refuse to reconcile when the next snapshot
  // is drastically smaller than the previously-indexed one AND the file's
  // mtime is fresh — the caller schedules a delayed re-read so a real
  // shrink eventually applies while a partial read is discarded.
  if (previousMetadata && isLikelyPartialRead(previousMetadata, nextMetadata)) {
    return { action: 'partial-read-retry', reason: 'size-shrink' };
  }

  return { action: 'reload-silently', reason: 'editor-clean' };
}

const MIN_PARTIAL_READ_PRIOR_BYTES = 1024;
const PARTIAL_READ_SHRINK_RATIO = 0.1;
/**
 * Mtime-stability window for the partial-read heuristic. A file shrunk more
 * than this many milliseconds ago is treated as a deliberate edit, so
 * `reload-silently` fires and the editor catches up.
 *
 * 1 s because a slow disk or synced filesystem can leave well over 100 ms
 * between the truncate (which stamps the mtime) and the watcher's debounced
 * re-read. Only DRASTIC (>90%) shrinks are affected; a genuine drastic
 * deletion inside the window is held back at most ~5 s (bounded retry)
 * before the exhaustion prompt lets the user apply it.
 */
const PARTIAL_READ_MTIME_WINDOW_MS = 1000;

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    try { return new TextEncoder().encode(text).length; } catch { /* fall through */ }
  }
  return text.length;
}

/**
 * Heuristic for "this almost certainly caught a mid-write truncated state".
 *
 * A >90% shrink on a ≥1 KB file is the partial-read signature (external
 * truncate-then-rewrite caught mid-flight); a legitimate edit that drops a
 * sentence shrinks by far less. Percentage-based so a 100 KB file landing at
 * 5 KB is caught too.
 *
 * Also requires `next.lastModified` to be within
 * {@link PARTIAL_READ_MTIME_WINDOW_MS} of `now`: a file shrunk longer ago has
 * already finished its rewrite. `now` is a parameter for tests.
 *
 * The window is about *recency*, not direction, so it uses `Math.abs`: synced
 * volumes (OneDrive / SMB) often stamp mtimes slightly AHEAD of the local
 * clock, and a future mtime is just as suspicious as a recent past one.
 *
 * DECISION (future mtimes): NOT treated as settled beyond some tolerance.
 * On a clock-skewed volume a mid-write and a settled truncation are
 * indistinguishable from one stat, so any such tolerance would re-open the
 * clean-editor clobber. The retry-then-exhaustion prompt is the disambiguator;
 * a brief delay is the price.
 */
function isLikelyPartialRead(
  prev: FileMetadata,
  next: FileMetadata,
  now: number = Date.now(),
): boolean {
  // Measure the RAW file size (FM + body) when available, not
  // the parsed body alone. A truncation that lands mostly in a large frontmatter
  // block leaves the body looking intact, so a body-only ratio would miss it.
  // Falls back to the body byte length for synthetic metadata without rawByteSize.
  const prevSize = prev.rawByteSize ?? utf8ByteLength(prev.content);
  if (prevSize < MIN_PARTIAL_READ_PRIOR_BYTES) return false;
  const nextSize = next.rawByteSize ?? utf8ByteLength(next.content);
  if (nextSize >= prevSize * PARTIAL_READ_SHRINK_RATIO) return false;
  // Only fire when the shrink is RECENT — an old mtime means the rewrite
  // already finished and we're looking at stable state. `Math.abs` so a
  // clock-skewed FUTURE mtime (OneDrive/SMB) is held for retry too, not
  // mistaken for a settled edit.
  const ageMs = Math.abs(now - next.lastModified);
  return ageMs < PARTIAL_READ_MTIME_WINDOW_MS;
}

/**
 * Body is considered equivalent when the parsed Markdown content + heading
 * structure is the same. We compare the raw body string (already stripped
 * of frontmatter by `parseMarkdown`) for exact equality.
 */
function isBodyEquivalent(a: FileMetadata, b: FileMetadata): boolean {
  if (a.content !== b.content) return false;
  if (a.headings.length !== b.headings.length) return false;
  for (let i = 0; i < a.headings.length; i++) {
    const ah = a.headings[i];
    const bh = b.headings[i];
    if (!ah || !bh) return false; // equal lengths + in-range; not-equivalent is the safe direction
    if (ah.text !== bh.text) return false;
    if (ah.level !== bh.level) return false;
  }
  return true;
}

function frontmatterEqual(a: FileMetadata, b: FileMetadata): boolean {
  // Deliberately `valuesEqual` (frontmatterEngine), NOT `fmValueEqual` /
  // `fmDeepEqual` (frontmatterRebase): those compare arrays as an order-
  // INSENSITIVE multiset and treat a Date as a keyless object. This resolver
  // decides whether DISK diverged from the in-memory copy, so array order must
  // stay significant (an externally REORDERED `tags: [...]` is a real byte
  // change the cache must adopt) and a residual Date must compare by instant.
  // `valuesEqual` still recurses key-order-insensitively for a
  // nested map, so a `{author, date}` → `{date, author}` external rewrite reads
  // as a no-op rather than a spurious `sync-frontmatter`.
  return valuesEqual(a.frontmatter, b.frontmatter);
}
