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
   * Sprint C / C.1 — true when an open Properties popup has unflushed row
   * edits against `path`. The caller (vaultExternalChanges) consults the
   * sibling `propertiesPopupTracker` and passes the bool in; we keep the
   * classifier free of store imports so the unit tests stay simple.
   *
   * Defaults to false so existing callers that don't yet pass the flag
   * retain the pre-Sprint-C behaviour.
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
      // VS1 (Audit-6) — even a frontmatter-only delta can be a mid-write
      // truncated read: the surviving body bytes happen to match the prior
      // version, but the RAW file shrank drastically (the FM block was caught
      // mid-rewrite). Applying it would push a truncated frontmatter into tile
      // caches / tags with no editor open to protect them. Hold for a delayed
      // re-read — same raw-shrink + fresh-mtime signature the editor-clean
      // branch already guards. (rawByteSize makes this fire even though the
      // body — and thus the body-only ratio — looks unchanged.)
      if (isLikelyPartialRead(previousMetadata, nextMetadata)) {
        return { action: 'partial-read-retry', reason: 'size-shrink' };
      }
      // Sprint C / C.1 — popup is the canonical frontmatter authority while
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
    // Audit-10 M4 — we are past the body-equivalent short-circuit, so the BODY
    // changed; and no editor owns this path. If the FRONTMATTER also changed we
    // must still sync it: otherwise a closed-file Kanban card / Task row keeps
    // stale metadata in its tile cache / tag store / seeded-FM cache and renders
    // (and computes its field-edit inverse) against the pre-external-edit values.
    // The body itself needs no action — no editor holds it and the next tile
    // load hydrates fresh from disk. Guard the same mid-write partial-read
    // signature the editor branches do so a truncated read isn't pushed into the
    // caches as if it were settled metadata.
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

  // Phase 22 M9 — guard against mid-write partial reads. An external tool
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
 * Phase 1 / 1.6 — mtime-stability window for the partial-read heuristic.
 * A file shrunk more than this many milliseconds ago is treated as a
 * deliberate edit (the rewrite completed; the mtime represents a stable
 * state), so `reload-silently` fires and the editor catches up.
 *
 * M5 (2026-05-28) — widened from 100 ms to 1000 ms. The 100 ms bound assumed
 * truncate-open and rewrite-completion are only a few hundred ms apart, but a
 * slow disk or a networked/synced filesystem can leave well over 100 ms
 * between the truncate (which stamps the mtime) and the watcher's debounced
 * re-read. A drastic (>90%) shrink seen 100–1000 ms after the mtime was
 * therefore misclassified as a settled real edit and applied via
 * `reload-silently`, clobbering the clean editor with a partial read.
 *
 * Widening only affects DRASTIC shrinks (the `PARTIAL_READ_SHRINK_RATIO`
 * gate still requires a >90% drop): a routine edit that trims a sentence is
 * nowhere near the bar and still reloads immediately. A genuine drastic
 * deletion within the window is held back at most ~5 s (the bounded retry
 * schedule) before the exhaustion prompt lets the user apply it — the cost
 * of a brief delay on a rare deliberate truncation, in exchange for not
 * silently destroying the view on a slow mid-write read.
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
 * C2 — percentage-based threshold. A >90% shrink on a ≥1 KB file is the
 * partial-read signature: external truncate-then-rewrite caught mid-flight.
 * A legitimate edit that drops a sentence or two from a long note shrinks
 * by 5–20%, well below the 10% retention bar. The previous absolute 64-byte
 * cap fired on short truncations but missed a 100 KB file landing at 5 KB
 * mid-write — well within partial-read territory but past the absolute cap.
 *
 * Phase 1 / 1.6 — also requires `next.lastModified` to be within the
 * partial-read mtime window (defaults to {@link PARTIAL_READ_MTIME_WINDOW_MS}
 * relative to `now`). A file shrunk seconds or more ago has had its
 * rewrite committed already; treating it as a partial read keeps the user
 * looking at stale content waiting for a retry that won't change anything.
 * `now` is a parameter so tests can pin a deterministic baseline; production
 * callers default to `Date.now()`.
 *
 * A8-H1 (Audit-8) — the window is about *recency*, not direction, so it is
 * measured with `Math.abs`. OneDrive / SMB / other synced volumes routinely
 * stamp a file's mtime slightly AHEAD of the local clock; a strict `ageMs >= 0`
 * gate then read a future mtime as "not recent", let the >90% mid-write
 * truncation fall through to `reload-silently`, and clobbered a clean editor
 * with the partial read. A future mtime within the window is exactly as
 * suspicious as a past one — both mean "the rewrite is probably still in flight".
 */
function isLikelyPartialRead(
  prev: FileMetadata,
  next: FileMetadata,
  now: number = Date.now(),
): boolean {
  // L12 (Audit-6) — measure the RAW file size (FM + body) when available, not
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
  // mistaken for a settled edit (A8-H1).
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
    if (a.headings[i].text !== b.headings[i].text) return false;
    if (a.headings[i].level !== b.headings[i].level) return false;
  }
  return true;
}

function frontmatterEqual(a: FileMetadata, b: FileMetadata): boolean {
  const ak = Object.keys(a.frontmatter).sort();
  const bk = Object.keys(b.frontmatter).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    // L14 (Audit-6) — compare values structurally, not via `JSON.stringify`.
    // The stringify form was key-order-SENSITIVE for nested objects: a YAML map
    // `{author, date}` reloaded as `{date, author}` (same data, different key
    // order after an external rewrite) stringified unequal → a spurious
    // `sync-frontmatter` that reshuffled tile caches/tags for no real change.
    // `valuesEqual` recurses key-order-insensitively (and compares Dates by
    // instant), matching the FM engine's own equality contract.
    if (!valuesEqual(a.frontmatter[ak[i]], b.frontmatter[bk[i]])) {
      return false;
    }
  }
  return true;
}
