/**
 * syncOpenEditorsAfterDiskMutation — shared helper for "we just wrote disk
 * authoritatively, now sync every open editor on those paths".
 *
 * {@link writeMarkdownAndReconcile} at the bottom of this file is the
 * canonical COUPLED helper that does the direct `.md` write AND the matching
 * reconcile for the SAME path in one call. New non-gateway writers should call
 * that, not pair a raw write with one of the reconcile functions by hand.
 *
 * Background. Whenever Filo writes a `.md` file outside the per-editor
 * debounced gateway — `ReplaceAllCommand`, `CascadeDeleteCommand.undo`,
 * `tagRewriteSweep`, `recreateDeletedFile` — an open editor on that path keeps
 * its prior in-memory body, and its next debounced write would silently invert
 * our authoritative write ~300 ms later.
 *
 * What it does. For every `(path, content)` pair, find an open
 * `DocumentState` by filename, parse the new bytes once, and call
 * `documentStore.applyReloadFromDisk(...)` with `frontmatter` AND
 * `rawFrontmatter`. `applyReloadFromDisk` itself cancels armed body writers
 * for the docId before replacing state, so no separate
 * `cancelMarkdownWritesForDocument` call is needed (the CI gate
 * `scripts/gates:reload-cancels-writes` forbids pairing them manually).
 *
 * No re-read from disk. Each caller already has the bytes it wrote (or
 * assembled) in memory, so the helper parses those bytes directly. A
 * re-read would race: an external editor could land a write between our
 * write and our re-read, and the open editor would silently absorb the
 * external bytes instead of converging on what we just authoritatively
 * wrote.
 *
 * Restricted to disk-mutation-then-restore callers. The 7+ prompt-driven
 * `applyReloadFromDisk` call sites in `stores/vaultExternalChanges.ts`
 * (Reload toast handlers, classifier-driven reloads) deliberately stay
 * inline — they are user-acknowledged reloads against an external editor's
 * authoritative state, not Filo-initiated disk writes, so re-reading is
 * already what the caller wants. The CI gate enforces the boundary by
 * banning `cancelMarkdownWritesForDocument` outside this helper,
 * `markdownFileWriter.ts`, and `document.svelte.ts`.
 */

import { documentStore } from '../../stores/document.svelte';
import { parseMarkdownFile } from '../editor/markdownSync';
import { invokeOk } from '../utils/invokeOk';
import { createMdFileExclusive } from './createMdExclusive';
import {
  trackComponentWrite,
  type TrackComponentWriteOptions,
} from '../boards/writeStateTracking';

/**
 * Sync every open editor whose filename matches one of `items` to the
 * post-mutation bytes the caller just wrote. No-op when no editor is open
 * on the path.
 *
 * `items[i].content` must be the exact bytes that landed on disk for
 * `items[i].path` — the helper parses them once via `parseMarkdownFile`
 * and routes the result through `applyReloadFromDisk`. Pass the assembled
 * fileText, not the body-only payload, so frontmatter splits correctly.
 *
 * Synchronous — `applyReloadFromDisk` is sync (the cancel + state swap
 * are both synchronous; frontmatter flush is fire-and-forget). Returning
 * void keeps callers from awaiting nothing.
 */
export function syncOpenEditorsAfterDiskMutation(
  items: ReadonlyArray<{ path: string; content: string }>,
): void {
  for (const item of items) {
    const doc = documentStore.findByFilename(item.path);
    if (!doc) continue;
    const parsed = parseMarkdownFile(item.content);
    documentStore.applyReloadFromDisk(
      doc.docId,
      parsed.body,
      doc.richText,
      parsed.frontmatter,
      parsed.rawFrontmatter,
    );
  }
}

/**
 * FRONTMATTER-ONLY reconcile after a direct `.md` write that
 * touched only the frontmatter (the single-tag fast path in `fileTags`).
 *
 * Unlike {@link syncOpenEditorsAfterDiskMutation}, this NEVER replaces the
 * editor body. A tag write reads disk bytes (which may lag a still-debouncing
 * editor body edit by up to ~300 ms); reloading the body from those bytes would
 * roll back the user's unsaved keystrokes. We only refresh the open editor's
 * frontmatter cache (`setFrontmatter`, which also re-seeds the clean-bytes and
 * the source-preserving baseline) so the editor's NEXT body save assembles the
 * file with the new tag instead of passing through its stale pre-tag frontmatter
 * and silently dropping it. The body the user is editing is left untouched.
 *
 * `items[i].content` must be the exact bytes that landed on disk for
 * `items[i].path`. No-op when no editor is open on the path.
 */
export function reconcileOpenEditorFrontmatter(
  items: ReadonlyArray<{ path: string; content: string }>,
): void {
  for (const item of items) {
    const doc = documentStore.findByFilename(item.path);
    if (!doc) continue;
    const parsed = parseMarkdownFile(item.content);
    documentStore.setFrontmatter(doc.docId, parsed.frontmatter, parsed.rawFrontmatter);
  }
}

/**
 * The COUPLED write-and-reconcile helper: the one true way for a non-gateway
 * caller to write a `.md` file. It performs the direct disk write AND the
 * matching open-editor reconcile for the SAME `path`, so the write-path and the
 * reconciled-path cannot diverge by construction (enforced by
 * `gates:md-writers-reconcile-editors`).
 *
 * Write channel:
 *  - `create: false` (default) → `vault:write-existing-file-text` — the file
 *    MUST already exist, so a race with an external delete surfaces as ENOENT
 *    instead of resurrecting the file (edits: tag fast path, Replace All,
 *    tag-rename sweep).
 *  - `create: true` → `vault:write-file-text` — mkdir -p, creates if absent
 *    (resurrections: cascade-delete undo, Keep-local recreation).
 *
 * Reconcile `mode` (see the two helpers above):
 *  - `'full'`        → body + frontmatter reload. The caller already flushed /
 *    superseded the editor, so there is no unsaved body to clobber.
 *  - `'frontmatter'` → frontmatter-only, body-preserving (the tag fast path,
 *    whose on-disk bytes may lag a still-debouncing editor body edit).
 *
 * The write runs inside {@link trackComponentWrite} so it joins the in-flight
 * counter / `.filo/.dirty` sentinel / recent-self-write registry.
 * `trackComponentWrite` re-throws on failure, so the reconcile runs ONLY after
 * the bytes actually landed — a failed write never reconciles an editor to
 * content that isn't on disk. Callers that aggregate failures wrap this in
 * their own try/catch and pass `track: { notifyOnError: false }` to suppress
 * the per-write toast.
 *
 * The post-write drift-baseline refresh stays at the call site —
 * only the tag fast path needs it and it requires a post-write `vault:stat`
 * this helper deliberately does not perform.
 */
export interface WriteMarkdownAndReconcileOptions {
  vaultRoot: string;
  /** Vault-relative path of the `.md` file. The write AND the reconcile use it. */
  path: string;
  /** Exact bytes to land on disk (assembled fileText, not body-only). */
  content: string;
  /** `'full'` = body + frontmatter reload; `'frontmatter'` = FM-only, body-preserving. */
  mode: 'full' | 'frontmatter';
  /**
   * `true` = create-or-overwrite channel (mkdir -p); `false`/omitted = write-
   * existing channel. `'exclusive'` = create ONLY if nothing
   * is there (`vault:create-file-text`, O_EXCL): resolves `'exists'` without
   * writing or reconciling when the path is occupied.
   */
  create?: boolean | 'exclusive';
  /** Forwarded to {@link trackComponentWrite} (e.g. `{ notifyOnError: false }` for bulk loops). */
  track?: TrackComponentWriteOptions;
}

export async function writeMarkdownAndReconcile(
  options: WriteMarkdownAndReconcileOptions,
): Promise<'written' | 'exists'> {
  const { vaultRoot, path, content, mode, create = false, track } = options;
  if (create === 'exclusive') {
    // Path-less tracking (createMdExclusive): a LOSING attempt targets a file
    // someone else just created, whose marks must stay untouched.
    if ((await createMdFileExclusive(vaultRoot, path, content)) === 'exists') return 'exists';
  } else await trackComponentWrite(
    vaultRoot,
    path,
    create
      // allow-direct-write: THE coupled write+reconcile helper — creates/restores the file (mkdir -p); the open-editor reconcile for this exact path runs immediately below.
      ? () => invokeOk('vault:write-file-text', vaultRoot, path, content)
      // allow-direct-write: THE coupled write+reconcile helper — edits an existing .md; the open-editor reconcile for this exact path runs immediately below.
      : () => invokeOk('vault:write-existing-file-text', vaultRoot, path, content),
    track ?? {},
  );
  // The bytes landed (trackComponentWrite re-throws on failure). Reconcile the
  // SAME path the write targeted — coupling both halves to one `path` argument
  // is the whole point of this helper.
  if (mode === 'frontmatter') {
    reconcileOpenEditorFrontmatter([{ path, content }]);
  } else {
    syncOpenEditorsAfterDiskMutation([{ path, content }]);
  }
  return 'written';
}
