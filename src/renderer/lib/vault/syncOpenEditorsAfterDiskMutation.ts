/**
 * syncOpenEditorsAfterDiskMutation — shared helper for "we just wrote disk
 * authoritatively, now sync every open editor on those paths" (Phase 6.1.R1).
 *
 * Background. Whenever Filo writes a `.md` file outside the per-editor
 * debounced gateway — `ReplaceAllCommand` (vault-wide find/replace),
 * `CascadeDeleteCommand.undo` (resurrects deleted file bodies),
 * `tagRewriteSweep` (vault-wide tag rename/removal), and
 * `recreateDeletedFile` (the Keep-local handler for an external delete) —
 * the `.board.json`/text-tile editor on that path keeps its prior in-memory
 * body. The next keystroke schedules a debounced write that carries the
 * pre-mutation body and silently inverts our authoritative write ~300 ms
 * later. Audit-3 surfaced four call sites with the same shape; the previous
 * audit also touched the pattern (`replaceAllCommand.syncOpenEditors`).
 * Hoisting the shape into one helper closes the class.
 *
 * What it does. For every `(path, content)` pair, find an open
 * `DocumentState` by filename, parse the new bytes once, and call
 * `documentStore.applyReloadFromDisk(...)` with `frontmatter` AND
 * `rawFrontmatter`. `applyReloadFromDisk` itself now cancels armed body
 * writers for the docId before replacing state (Phase 6.0.C2), so the
 * helper does not need a separate `cancelMarkdownWritesForDocument` call —
 * doing so manually adjacent to `applyReloadFromDisk` is the very pattern
 * the new CI gate (`check-reload-cancels-writes.mjs`) forbids.
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
