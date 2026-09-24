import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { RichTextAnnotation } from '../schema/document';
import { uiStore } from './ui.svelte';
import { samePath, normalizePath, stripLeadingSlash, toPosix } from '../lib/utils/path';
import {
  cancelMarkdownWritesForDocument,
  cancelAndAwaitMarkdownWritesForDocument,
  forceWriteForDocument,
} from '../lib/vault/markdownFileWriter';
import { noteBaseline } from '../lib/vault/fileBaselineRegistry';
import { flushAllPendingFrontmatterWrites } from '../lib/boards/frontmatterWriteScheduler';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';
import { backupExternalVersion } from '../lib/vault/keepLocalBackup';
import { onVaultSwap } from '../core/vaultLifecycle';

/**
 * Document store — manages open document tabs and syncs content
 * between tile views on canvas and expanded document editor tabs.
 *
 * Each document corresponds to a .md file in the vault (supports nested folders).
 * A document can be displayed simultaneously as a tile on a canvas
 * and as a full-screen editor tab. Edits in either view propagate
 * to the shared state here.
 */

export interface DocumentState {
  docId: string;
  filename: string;       // relative path from vault root (e.g. "notes/Project Overview.md")
  title: string;          // display name (filename without .md)
  body: string;           // Markdown content
  htmlContent: string;    // Tiptap HTML (rendered from Markdown + richText)
  richText: RichTextAnnotation[];
  isDirty: boolean;
}

/**
 * Read-only docs.
 *
 * When `loadMarkdownIntoEditor` detects that the body failed to round-trip
 * through tiptap-markdown (Obsidian callouts, math blocks, `==highlight==`,
 * etc.), the doc is added to this set so the debounced markdown writers
 * skip it. The user can flip it off via `takeOwnership(docId)` after a
 * confirm dialog. Stored separately from `DocumentState` so docs not yet
 * registered via `loadDocument` (possible during the first hydrate) can
 * still be marked.
 */
const readOnlyDocs = new SvelteSet<string>();
let readOnlyVersion = $state(0);

// ── Reactive state ──

const openDocuments = new SvelteMap<string, DocumentState>();
let activeDocId = $state<string | null>(null);

/**
 * The vault these documents belong to. Bound to the INCOMING vault when
 * `clear()` runs in the pre-swap handler (while the outgoing vault is still
 * semantically active). A stale tile `$effect` from the outgoing vault could
 * otherwise repopulate the map with old-vault content, and a later debounced
 * write would emit that path into the new vault's root. `loadDocument`
 * refuses inserts whose live `getActiveVaultPath()` doesn't match `boundVault`.
 * `null` means unbound (first open / post-close) — the first load then adopts
 * the live vault. Read via the `activeVaultPath` leaf (not `vaultStore`) to
 * avoid an import cycle through vault.svelte.ts.
 */
let boundVault: string | null = null;

/**
 * Per-writer dirty tracking. Each open editor on a file (a TextTile and/or a
 * DocumentEditor share one docId) adds its stable `callerId` here when it has
 * unsaved content and removes it on a successful flush. `DocumentState.isDirty`
 * stays true while ANY writer is still dirty, so one editor flushing can't
 * clear the shared flag under a sibling that still has unsaved keystrokes.
 * Callers that pass no `writerId` get "clear everything" semantics.
 */
const dirtyWriters = new SvelteMap<string, SvelteSet<string>>();

function addDirtyWriter(docId: string, writerId: string): void {
  let set = dirtyWriters.get(docId);
  if (!set) {
    set = new SvelteSet<string>();
    dirtyWriters.set(docId, set);
  }
  set.add(writerId);
}

/**
 * Shared frontmatter live-cache keyed by docId. The four disk writers
 * (TextTile, DocumentEditor, PropertiesPopup, TaskListBoard) all read and
 * mutate this cache instead of carrying their own per-component copies.
 * Without it, a write from one component would assemble its file from a
 * stale snapshot of frontmatter and silently clobber another component's
 * concurrent edit. The cache is the canonical in-memory frontmatter — last
 * debounce-wins is safe because every writer pulls from the same source.
 */
const frontmatterCache = new SvelteMap<string, Record<string, unknown>>();
let frontmatterVersionTick = $state(0);

/**
 * Verbatim frontmatter source bytes per docId, captured when an authoritative
 * disk read seeds the cache (`setFrontmatter` / `applyReloadFromDisk` with a
 * non-empty `rawFrontmatter`). Its PRESENCE is the "clean" signal: while an
 * entry exists, the on-disk frontmatter is byte-identical to what we parsed,
 * so a body-only save can emit it verbatim (preserving comments, key order, and
 * line endings) instead of re-serialising the object.
 *
 * Any frontmatter MUTATION — `mergeFrontmatter`, or a `setFrontmatter` that
 * carries no disk bytes (a PropertiesPopup / task / kanban write) — drops the
 * entry, forcing the next write back through the (lossy but correct) dump path.
 * A body-only edit never touches the frontmatter, so the entry survives and the
 * common case keeps its formatting.
 */
const rawFrontmatterCache = new SvelteMap<string, string>();

/**
 * The last frontmatter SOURCE bytes read from disk for a docId, retained
 * ACROSS in-app mutations (unlike `rawFrontmatterCache`). On a dirty write the
 * source-preserving engine (`patchFrontmatterSourceCst`) diffs the live object
 * against THIS baseline and re-emits only the changed keys, so comments / key
 * order / quoting on every untouched key survive a metadata edit. Refreshed on
 * every authoritative disk read; never cleared by a mutation. Data-safe even
 * when stale: the engine always emits the full live object.
 */
const originalFrontmatterCache = new SvelteMap<string, string>();

/**
 * Stores `rawFrontmatter` as the clean-bytes entry for `docId` when it is a
 * non-empty disk block, otherwise drops any existing entry. Centralises the
 * "presence == clean" rule so every seed / reload / mutation path agrees.
 */
function noteRawFrontmatter(docId: string, rawFrontmatter: string | undefined): void {
  if (rawFrontmatter !== undefined && rawFrontmatter.trim().length > 0) {
    rawFrontmatterCache.set(docId, rawFrontmatter);
    // Persist the disk baseline for source-preserving dirty writes. NOT
    // dropped in the else branch: a mutation clears the clean signal above, but
    // the engine still needs the original bytes to diff against.
    originalFrontmatterCache.set(docId, rawFrontmatter);
  } else {
    rawFrontmatterCache.delete(docId);
  }
}

/**
 * Per-docId monotonic mutation counter — the write-staleness TOKEN. Every
 * `mergeFrontmatter` / `setFrontmatter` call increments the docId's entry, and
 * so does every body change via `updateContent` (a body mutation makes a
 * flushed snapshot stale just like an FM mutation). A writer that captures the
 * value at schedule time can later detect whether another writer has since
 * flushed a newer version. Used by `frontmatterWriteScheduler` to skip stale
 * debounced writes. Without the body bump, a delta-less body write (Task notes)
 * would be skipped as stale and reported as success — lost on quit.
 *
 * NOT deleted on `clearFrontmatter` / `unloadDocument` (cleared only on the
 * whole-store `clear()`, matching the scheduler's `lastFlushedVersion`
 * lifecycle). docIds are stable, so an unload+reopen reuses the docId;
 * resetting the counter would make early writes after a reopen compare against
 * the pre-unload high-water mark and be silently skipped.
 *
 * Kept outside `frontmatterCache` so external-edit reloads can bump it
 * without rebuilding the cache Map (which Svelte tracks as a single
 * reactive reference).
 */
const mutationVersions = new SvelteMap<string, number>();

/**
 * Per-docId count of BODY bumps folded into `mutationVersions` (bumped only by
 * `updateContent`, in lockstep with the shared map). Lets
 * `getFrontmatterOnlyMutationVersion` recover the FM-only count (shared − body)
 * for consumers that must ignore body churn — e.g. the disk-FM refresh seed,
 * so a racing notes keystroke doesn't block the refresh. Same lifecycle as
 * `mutationVersions` (SvelteMap for lint conventions, not reactivity).
 */
// allow-module-state: cleared in clear() alongside mutationVersions (vault swap)
const bodyMutationVersions = new SvelteMap<string, number>();

function bumpMutationVersion(docId: string): number {
  const next = (mutationVersions.get(docId) ?? 0) + 1;
  mutationVersions.set(docId, next);
  return next;
}

const utf8Encoder =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function utf8ByteLength(text: string): number {
  if (utf8Encoder) return utf8Encoder.encode(text).length;
  // Fallback for environments without TextEncoder — approximate via char count.
  return text.length;
}

/**
 * Human-readable hint for the external-edit toast. Reports the signed UTF-8
 * byte delta so users can tell at a glance whether the upstream change is
 * a small tweak (+12 bytes) or a wholesale rewrite (+8.4k). Falls back to
 * "modified" when sizes match — a same-size content swap is unusual but
 * still meaningful.
 */
function formatBodyDelta(oldBody: string, newBody: string): string {
  const oldBytes = utf8ByteLength(oldBody);
  const newBytes = utf8ByteLength(newBody);
  const delta = newBytes - oldBytes;
  if (delta === 0) return 'modified';
  const sign = delta > 0 ? '+' : '−';
  const magnitude = Math.abs(delta);
  return `${sign}${magnitude} bytes`;
}

export const documentStore = {
  /** All currently open documents (tile content loaded into memory). */
  get documents() { return openDocuments; },

  /** The currently focused document tab (null if no document tab is active). */
  get activeDocId() { return activeDocId; },

  /** Reactive cursor — any $derived that reads it refreshes after a set/merge/clear. */
  get frontmatterVersion() { return frontmatterVersionTick; },

  /** Get a specific document by its ID. */
  getDocument(docId: string): DocumentState | undefined {
    return openDocuments.get(docId);
  },

  /**
   * True while `writerId` (one editor view, keyed by its stable callerId)
   * still holds unsaved content for `docId`. Each editor's reload `$effect`
   * gates on its OWN writer here instead of the shared `isDirty` flag, which
   * would freeze every view's reload — two views editing inside one debounce
   * window would diverge and the last full-body flush would drop the other's
   * keystrokes. Per-writer gating lets a clean sibling reload the latest body.
   *
   * Reactive — reads the SvelteMap/SvelteSet so a reading effect re-runs when
   * the writer's dirty state flips.
   */
  isWriterDirty(docId: string, writerId: string): boolean {
    return dirtyWriters.get(docId)?.has(writerId) ?? false;
  },

  /**
   * Finds the loaded document whose backing filename matches the given
   * vault-relative path (case-insensitive, slash-normalised). Returns
   * `null` when no editor currently holds that file.
   */
  findByFilename(relPath: string): DocumentState | null {
    if (!relPath) return null;
    for (const doc of openDocuments.values()) {
      if (samePath(doc.filename, relPath)) {
        return doc;
      }
    }
    return null;
  },

  /**
   * Returns the cached frontmatter for a docId, or undefined if not seeded.
   * Writers must treat a missing entry as "seed me first" — the cache is the
   * source of truth once seeded, so reading from elsewhere risks reverting
   * concurrent mutations from another writer.
   */
  getFrontmatter(docId: string): Record<string, unknown> | undefined {
    void frontmatterVersionTick;
    return frontmatterCache.get(docId);
  },

  /**
   * Whether the frontmatter live-cache already holds an entry for `docId`.
   * The cached-body / adoption hydrate branches consult this before trusting
   * the in-memory (body-only) `DocumentState.body` as a hydrate source:
   * re-parsing frontmatter from a body-only string yields `{}`, which would
   * clobber the real frontmatter and let a later body-only save erase the
   * file's frontmatter block. Reactive via the version tick.
   */
  hasFrontmatter(docId: string): boolean {
    void frontmatterVersionTick;
    return frontmatterCache.has(docId);
  },

  /**
   * Replaces the cached frontmatter for a docId. Called on initial hydrate
   * (when a TextTile / DocumentEditor / TaskListBoard parses the .md for
   * the first time) and on external-change reload.
   *
   * Pass `rawFrontmatter` (the verbatim YAML source from a disk
   * parse) so a subsequent body-only save can emit those bytes untouched. Omit
   * it (or pass an empty block) for a mutation set — that drops any clean-bytes
   * entry so the next write re-dumps the object.
   */
  setFrontmatter(docId: string, fm: Record<string, unknown>, rawFrontmatter?: string): void {
    frontmatterCache.set(docId, { ...fm });
    noteRawFrontmatter(docId, rawFrontmatter);
    bumpMutationVersion(docId);
    frontmatterVersionTick++;
  },

  /**
   * The verbatim frontmatter source for `docId` while it is
   * still byte-identical to disk (a body-only save may emit it untouched), or
   * `undefined` once a mutation has invalidated it. The write gateway reads
   * this to decide between passthrough and a re-dump.
   */
  getRawFrontmatter(docId: string): string | undefined {
    void frontmatterVersionTick;
    return rawFrontmatterCache.get(docId);
  },

  /**
   * The disk-baseline frontmatter source for `docId` (persists
   * across mutations; see `originalFrontmatterCache`). The write gateway passes
   * this to `assembleMarkdownFile` so a dirty (frontmatter-changed) save patches
   * the original bytes source-preservingly instead of re-dumping the object.
   */
  getOriginalFrontmatterSource(docId: string): string | undefined {
    void frontmatterVersionTick;
    return originalFrontmatterCache.get(docId);
  },

  /**
   * Returns the docId's monotonic mutation counter — incremented on every
   * `mergeFrontmatter` / `setFrontmatter` AND every body
   * change via `updateContent`. Writers capture this at schedule time and
   * compare against the last-flushed value to decide whether their flush is
   * still the freshest.
   */
  getFrontmatterMutationVersion(docId: string): number {
    return mutationVersions.get(docId) ?? 0;
  },

  /**
   * The FM-ONLY mutation count (the shared counter minus the body bumps
   * `updateContent` folded in). For consumers that must ignore body churn: the
   * disk-FM refresh seed gates on "nothing mutated the FRONTMATTER since the
   * placeholder was seeded", which a racing notes keystroke must not block.
   */
  getFrontmatterOnlyMutationVersion(docId: string): number {
    return (mutationVersions.get(docId) ?? 0) - (bodyMutationVersions.get(docId) ?? 0);
  },

  /**
   * Merges a partial patch into the cached frontmatter. Returns the merged
   * object so the caller can pass it on to the assembled write without a
   * second lookup. Empty / undefined / null values in `patch` are deleted.
   */
  mergeFrontmatter(docId: string, patch: Record<string, unknown>): Record<string, unknown> {
    const base = frontmatterCache.get(docId) ?? {};
    const merged: Record<string, unknown> = { ...base, ...patch };
    // Clean ONLY the keys set in this patch, never the whole merged object: a
    // present-but-empty disk key the user didn't touch (`aliases:`,
    // `subtitle: ""`) must survive an unrelated field edit. An empty value in
    // `patch` is a clear → drop it.
    for (const k of Object.keys(patch)) {
      const v = merged[k];
      if (v === '' || v === undefined || v === null) delete merged[k];
    }
    frontmatterCache.set(docId, merged);
    // The object changed, so the captured raw bytes are stale: drop them
    // and let the next write re-dump the merged object.
    rawFrontmatterCache.delete(docId);
    bumpMutationVersion(docId);
    frontmatterVersionTick++;
    return merged;
  },

  /**
   * Drops the cached frontmatter for a docId. Called when the document is
   * unloaded so a future reopen reads a fresh copy from disk.
   */
  clearFrontmatter(docId: string): void {
    if (!frontmatterCache.has(docId)) return;
    frontmatterCache.delete(docId);
    rawFrontmatterCache.delete(docId);
    // Drop the disk baseline on doc unload so a future reopen re-reads
    // fresh bytes rather than patching against a stale source.
    originalFrontmatterCache.delete(docId);
    // `mutationVersions` is deliberately KEPT (see its docstring); cleared
    // only on the whole-store `clear()`.
    frontmatterVersionTick++;
  },

  /**
   * Registers a document in the store (called when a tile is loaded or a doc tab is opened).
   * If already loaded, returns the existing state.
   */
  loadDocument(doc: {
    docId: string;
    filename: string;
    title: string;
    body: string;
    htmlContent: string;
    richText: RichTextAnnotation[];
  }): DocumentState {
    const existing = openDocuments.get(doc.docId);
    if (existing) return existing;

    const state: DocumentState = {
      docId: doc.docId,
      filename: doc.filename,
      title: doc.title,
      body: doc.body,
      htmlContent: doc.htmlContent,
      richText: doc.richText,
      isDirty: false,
    };

    // Cross-vault repopulation guard. During a vault swap the
    // pre-swap handler clears the map and binds the store to the incoming
    // vault; until the committed vault path actually flips to that vault, any
    // load is a stale call from an outgoing-vault component that hasn't
    // unmounted yet, so return the constructed state WITHOUT inserting it (a
    // no-op for the store). When unbound (first open), adopt the live vault.
    const live = getActiveVaultPath();
    if (boundVault !== null && live !== boundVault) {
      return state;
    }
    if (boundVault === null) boundVault = live;

    openDocuments.set(doc.docId, state);
    return state;
  },

  /**
   * True iff loading detected lossy round-trip syntax and
   * the doc is held read-only. Reactive — components reading this re-render
   * when `setReadOnly` / `takeOwnership` fires.
   */
  isReadOnly(docId: string): boolean {
    void readOnlyVersion;
    return readOnlyDocs.has(docId);
  },

  /**
   * Marks a document read-only. Called by `loadMarkdownIntoEditor` when the
   * round-trip check detects syntax tiptap-markdown can't preserve.
   * Idempotent — repeated calls don't bump the reactive version.
   */
  setReadOnly(docId: string, value: boolean): void {
    if (value) {
      if (readOnlyDocs.has(docId)) return;
      readOnlyDocs.add(docId);
    } else {
      if (!readOnlyDocs.has(docId)) return;
      readOnlyDocs.delete(docId);
    }
    readOnlyVersion++;
  },

  /**
   * User-initiated "take ownership" — flips read-only off so the next
   * debounced write proceeds. Callers should confirm with the user first
   * ("this will overwrite the file with what Filo can read"); this method
   * is the no-prompt commit point.
   */
  takeOwnership(docId: string): void {
    this.setReadOnly(docId, false);
  },

  /**
   * Updates document content (called from either tile editor or doc tab editor).
   * Both views will reactively pick up the change.
   */
  updateContent(docId: string, htmlContent: string, markdownBody?: string, writerId?: string) {
    // Dev tripwire. `body` is body-only by contract; frontmatter lives in
    // frontmatterCache. A full file (frontmatter + body) here would double the
    // frontmatter on the next serialize. Requires BOTH fences so a body that
    // merely opens with a thematic-break `---` doesn't false-positive.
    // Non-fatal — never block editing on a heuristic.
    if (
      import.meta.env.DEV &&
      markdownBody !== undefined &&
      /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(markdownBody)
    ) {
      console.error(
        `[documentStore] updateContent received what looks like a full file ` +
          `(leading frontmatter block) as markdownBody for docId=${docId} — body ` +
          `must be body-only; frontmatter lives in frontmatterCache. A full-file ` +
          `body would duplicate the frontmatter on save (Phase 7.6 regression?).`,
      );
    }

    const doc = openDocuments.get(docId);
    if (!doc) return;

    // Register the editing writer so a sibling editor's flush
    // can't clear `isDirty` while this writer still holds unsaved content.
    if (writerId) addDirtyWriter(docId, writerId);

    // A body change makes any previously-flushed snapshot stale, so it must
    // bump the shared write-staleness token — otherwise a delta-less write
    // (Task notes) is skipped as stale, reported as success, and lost on quit.
    // Mirrored into `bodyMutationVersions` so FM-only consumers can subtract it.
    if (markdownBody !== undefined && markdownBody !== doc.body) {
      bumpMutationVersion(docId);
      bodyMutationVersions.set(docId, (bodyMutationVersions.get(docId) ?? 0) + 1);
    }

    const updated: DocumentState = {
      ...doc,
      htmlContent,
      body: markdownBody ?? doc.body,
      isDirty: true,
    };

    openDocuments.set(docId, updated);
  },

  /**
   * Updates the document title (and triggers a file rename via IPC).
   */
  updateTitle(docId: string, newTitle: string) {
    const doc = openDocuments.get(docId);
    if (!doc) return;

    const updated: DocumentState = {
      ...doc,
      title: newTitle,
      isDirty: true,
    };

    openDocuments.set(docId, updated);
  },

  /**
   * Variant of `updateTitle` that preserves the current
   * `isDirty` flag instead of forcing it to true. Used by undo / redo of
   * title-rename commands: the rename itself doesn't change the body, so
   * flipping `isDirty` would queue the markdown scheduler to write the
   * in-memory body (potentially stale after external edits while the
   * rename was in place) back to the freshly-renamed-back file —
   * silently overwriting external edits.
   *
   * Direct user-typed title edits stay on `updateTitle` (the title
   * change IS a user edit, and the dirty flag drives the writer that
   * persists it).
   */
  updateTitleClean(docId: string, newTitle: string) {
    const doc = openDocuments.get(docId);
    if (!doc) return;

    const updated: DocumentState = {
      ...doc,
      title: newTitle,
    };

    openDocuments.set(docId, updated);
  },

  /**
   * Updates the filename after a rename operation completes.
   */
  updateFilename(docId: string, newFilename: string) {
    const doc = openDocuments.get(docId);
    if (!doc) return;

    const updated: DocumentState = {
      ...doc,
      filename: newFilename,
    };

    openDocuments.set(docId, updated);
  },

  /**
   * Repoints every open document affected by a
   * rename so its registered writer keeps targeting the moved path. Handles
   * the exact-match file rename (`Notes/old.md` → `Notes/new.md`) and the
   * folder-rename case where the open document is a *descendant* of the moved
   * folder (`Notes/Daily.md` → `Archive/Daily.md` when `Notes` → `Archive`).
   *
   * Mirrors the board-side `boardStore.propagateRename`. Both the in-app
   * rename path (vaultFolderOps) and the rename-cascade recovery retry
   * (vault.svelte.ts) call this so the two can't drift. Returns the number of
   * documents repointed.
   */
  propagateRename(oldRel: string, newRel: string): number {
    const oldRelNorm = normalizePath(stripLeadingSlash(oldRel));
    const newRelNorm = normalizePath(stripLeadingSlash(newRel));
    if (!oldRelNorm || !newRelNorm) return 0;
    const oldRelLower = oldRelNorm.toLowerCase();
    const oldPrefixLower = `${oldRelLower}/`;
    const updates: Array<{ docId: string; next: string }> = [];
    for (const doc of openDocuments.values()) {
      const docPath = stripLeadingSlash(toPosix(doc.filename));
      const docLower = docPath.toLowerCase();
      if (docLower === oldRelLower) {
        // Exact-match file rename.
        updates.push({ docId: doc.docId, next: newRelNorm });
      } else if (docLower.startsWith(oldPrefixLower)) {
        // Descendant of a renamed folder: rewrite the prefix, preserving the
        // tail's on-disk case (slice off the matched prefix length).
        updates.push({ docId: doc.docId, next: newRelNorm + docPath.slice(oldRelNorm.length) });
      }
    }
    for (const { docId, next } of updates) {
      const doc = openDocuments.get(docId);
      if (doc) openDocuments.set(docId, { ...doc, filename: next });
    }
    return updates.length;
  },

  /**
   * Opens a document in a dedicated editor tab.
   */
  openDocumentTab(docId: string) {
    activeDocId = docId;
  },

  /**
   * Marks a document as clean after a successful save.
   */
  markClean(docId: string, writerId?: string) {
    // Per-writer clear. Removing this writer leaves the doc dirty
    // if a sibling editor on the same file is still unsaved; only a fully
    // empty writer set (or a no-writerId call) flips `isDirty` off.
    if (writerId) {
      const set = dirtyWriters.get(docId);
      if (set) {
        set.delete(writerId);
        if (set.size > 0) return;
        dirtyWriters.delete(docId);
      }
    } else {
      dirtyWriters.delete(docId);
    }

    const doc = openDocuments.get(docId);
    if (!doc) return;

    const updated: DocumentState = {
      ...doc,
      isDirty: false,
    };

    openDocuments.set(docId, updated);
  },

  /**
   * Drops a single writer's dirty entry WITHOUT asserting its content reached
   * disk. `markClean` means "this writer saved"; this means "this writer is
   * going away." `TextTile.onDestroy` calls it so an unmounting tile can't
   * leave a phantom writerId pinning `DocumentState.isDirty` true — which would
   * cause spurious Reload prompts and freeze sibling-view reload `$effect`s.
   *
   * More conservative than `markClean`: it clears `isDirty` ONLY when it drained
   * the last TRACKED writer. A doc whose dirtiness came from a no-writerId
   * `markDirty` (e.g. a title edit) has no entry here, so this is a no-op and
   * leaves that flag untouched.
   */
  dropDirtyWriter(docId: string, writerId: string): void {
    const set = dirtyWriters.get(docId);
    if (!set || !set.has(writerId)) return;
    set.delete(writerId);
    if (set.size > 0) return;
    dirtyWriters.delete(docId);
    const doc = openDocuments.get(docId);
    if (!doc || !doc.isDirty) return;
    openDocuments.set(docId, { ...doc, isDirty: false });
  },

  /**
   * Marks a document as dirty. Called explicitly from per-component
   * writers (TextTile, DocumentEditor) when their debounced write fails, so a
   * sibling tile's reload `$effect` (gated on `isDirty`) cannot reload the
   * in-memory body and overwrite the editor's still-unsaved text with what is
   * already there. Belt-and-braces against future refactors that might
   * accidentally call `markClean` ahead of a write that subsequently fails.
   */
  markDirty(docId: string, writerId?: string) {
    // Record the writer before the dirty-flag short-circuit so a
    // second writer marking an already-dirty doc still registers (its later
    // clean must not clear the flag while the first writer is still dirty).
    if (writerId) addDirtyWriter(docId, writerId);
    const doc = openDocuments.get(docId);
    if (!doc) return;
    if (doc.isDirty) return;
    const updated: DocumentState = {
      ...doc,
      isDirty: true,
    };
    openDocuments.set(docId, updated);
  },

  /**
   * Unloads a document from memory (called when tile is removed
   * and no document tab is open for it).
   */
  unloadDocument(docId: string) {
    if (activeDocId === docId) {
      activeDocId = null;
    }
    openDocuments.delete(docId);
    dirtyWriters.delete(docId);
    rawFrontmatterCache.delete(docId);
    // Drop the disk-baseline FM source too (mirrors `clearFrontmatter`, which
    // this path doesn't route through) so the entry doesn't leak.
    originalFrontmatterCache.delete(docId);
    // `mutationVersions` deliberately survives unload (see its docstring).
    if (frontmatterCache.has(docId)) {
      frontmatterCache.delete(docId);
      frontmatterVersionTick++;
    }
    if (readOnlyDocs.has(docId)) {
      readOnlyDocs.delete(docId);
      readOnlyVersion++;
    }
  },

  /**
   * Clears all document state (called on project close/switch).
   *
   * `nextVault` binds the store to the incoming vault so a stale
   * outgoing-vault `loadDocument` is refused until `vaultStore.path` flips to
   * it. Defaults to null (unbound) for non-swap callers and tests.
   */
  clear(nextVault: string | null = null) {
    openDocuments.clear();
    activeDocId = null;
    dirtyWriters.clear();
    frontmatterCache.clear();
    rawFrontmatterCache.clear();
    // The disk-baseline FM sources persist across mutations by design, so the
    // reset must clear them explicitly.
    originalFrontmatterCache.clear();
    mutationVersions.clear();
    // Lockstep clear with the shared counter (matching the scheduler's
    // lastFlushedVersion lifecycle).
    bodyMutationVersions.clear();
    frontmatterVersionTick++;
    if (readOnlyDocs.size > 0) {
      readOnlyDocs.clear();
      readOnlyVersion++;
    }
    boundVault = nextVault;
  },

  /**
   * Handles an external file change detected by the file watcher.
   *
   * Dirty editors get a persistent Reload/Keep-local toast — the user must
   * explicitly choose. Auto-dismissal would silently default to keep-local
   * after 12s of inactivity, which loses the chance to pick up upstream
   * changes when the user is away from the screen.
   */
  handleExternalChange(
    docId: string,
    newBody: string,
    newRichText: RichTextAnnotation[],
    newFrontmatter?: Record<string, unknown>,
    // The disk read's verbatim FM source bytes, so the clean-editor reload
    // refreshes `originalFrontmatterCache` in lockstep with `frontmatterCache`;
    // otherwise an externally-added key loses its comment/quoting on next save.
    rawFrontmatter?: string,
    diskIdentity?: { mtimeMs?: number; size?: number },
  ) {
    const doc = openDocuments.get(docId);
    if (!doc) return;

    if (!doc.isDirty) {
      this.applyReloadFromDisk(docId, newBody, newRichText, newFrontmatter, rawFrontmatter, diskIdentity);
      return;
    }

    uiStore.pushToast({
      text: `"${doc.title}" was modified externally (${formatBodyDelta(doc.body, newBody)}). Reload from disk, or keep your local edits?`,
      type: 'warning',
      duration: 0,
      // Stays until answered; same key as vaultExternalPrompts'
      // promptModifiedFile so the two never double up for one file.
      sticky: true,
      dedupeKey: `ext-mod:${doc.filename}`,
      actions: [
        {
          label: 'Reload',
          handler: () =>
            this.applyReloadFromDisk(docId, newBody, newRichText, newFrontmatter, rawFrontmatter, diskIdentity),
        },
        {
          label: 'Keep local',
          // Force-write the current editor body to disk for exactly this
          // doc's writers. `forceWriteForDocument` bypasses the debounce-timer
          // guard (a plain flush no-ops if the debounce already fired, leaving
          // the external edit on disk). Mark dirty first so a concurrent
          // reload `$effect` can't undo the editor body before the write lands.
          // Back up the external version to .filo/recovery/ first; a declined
          // un-backed-up overwrite leaves both sides as-is.
          handler: async () => {
            const vaultRoot = getActiveVaultPath();
            if (!vaultRoot || !(await backupExternalVersion(vaultRoot, doc.filename))) return;
            if (getActiveVaultPath() !== vaultRoot || !openDocuments.has(docId)) return;
            this.markDirty(docId);
            void forceWriteForDocument(docId);
          },
        },
      ],
    });
  },

  /**
   * Upgrade an UNHYDRATED placeholder (body `''`) to the body a view just read
   * from disk. `loadDocument` returns an existing entry untouched, so without
   * this a placeholder would keep `''` while the editor shows the real body, and
   * a later reactive reload would load `''` back into the editor. Only a clean, empty
   * doc with no dirty writers is touched; unlike `applyReloadFromDisk` this does
   * NOT cancel writes or bump mutation versions (a read is not a user mutation).
   */
  adoptDiskBodyIfPlaceholder(docId: string, body: string, htmlContent: string): void {
    const doc = openDocuments.get(docId);
    if (!doc || doc.body !== '' || doc.isDirty) return;
    if ((dirtyWriters.get(docId)?.size ?? 0) > 0) return;
    if (body === '') return;
    openDocuments.set(docId, { ...doc, body, htmlContent });
  },

  /**
   * Overwrites the in-memory document with the newly-read disk content.
   * Called after the user confirms a reload or the editor was clean.
   * If newFrontmatter is provided, the live cache is updated too so the next
   * writer-assembled file picks up the external edits rather than reverting.
   *
   * Pass `rawFrontmatter` (the disk parse's verbatim source) alongside
   * `newFrontmatter` so a clean body-only save after the reload can still emit
   * the frontmatter bytes untouched. Omitted reloads drop the clean bytes (the
   * next write re-serialises) — safe, just without the formatting win.
   *
   * Pass `diskIdentity` (the read's mtime + byte size) so the
   * pre-write drift baseline is re-anchored to the bytes just applied; without
   * it the next keystroke re-detects the absorbed external edit and re-prompts.
   */
  applyReloadFromDisk(
    docId: string,
    newBody: string,
    newRichText: RichTextAnnotation[],
    newFrontmatter?: Record<string, unknown>,
    rawFrontmatter?: string,
    diskIdentity?: { mtimeMs?: number; size?: number },
  ) {
    const doc = openDocuments.get(docId);
    if (!doc) return;
    // Cancel any armed body writer for this doc FIRST: the gateway captured
    // `args.body` at schedule time, so a surviving timer would fire with the
    // pre-reload body and silently invert the reload. Synchronous so the
    // cancel-then-replace contract holds for non-awaiting callers.
    cancelMarkdownWritesForDocument(docId);
    // Disk is now authoritative, so every writer is clean.
    dirtyWriters.delete(docId);
    const updated: DocumentState = {
      ...doc,
      body: newBody,
      richText: newRichText,
      isDirty: false,
    };
    openDocuments.set(docId, updated);
    // Re-stamp the pre-write drift baseline to the disk identity just applied;
    // otherwise the next keystroke's drift check re-prompts for an edit the
    // user already accepted via Reload. Keyed by the doc's filename to match
    // the gateway's getBaseline(relPath). In-memory reloads (no diskIdentity)
    // don't re-stamp.
    if (diskIdentity) noteBaseline(doc.filename, diskIdentity.mtimeMs, diskIdentity.size);
    if (newFrontmatter) {
      frontmatterCache.set(docId, { ...newFrontmatter });
      noteRawFrontmatter(docId, rawFrontmatter);
      bumpMutationVersion(docId);
      frontmatterVersionTick++;
    }
    // Drain the frontmatter scheduler after the state swap. A delta-less entry
    // reads FM live at fire time, so it emits disk-truth (a no-op). A field
    // delta would re-apply the DISCARDED edit and revert the reload — so the
    // Reload-discard call sites drop this path's delta + timer
    // (`dropPendingDelta`) BEFORE calling here. Fire-and-forget.
    void flushAllPendingFrontmatterWrites();
  },
};

// Vault-swap reset: drops every loaded document, the frontmatter cache,
// mutation versions and read-only flags so the new vault can't see fragments
// of the prior vault's open documents.
onVaultSwap('pre-swap', 'document', async (event) => {
  // Before discarding open-document state, AWAIT any markdown write still in
  // flight for each open doc (cancels armed timers and awaits in-flight IPC),
  // so a writer can't land bytes against the outgoing vault after its state is
  // torn down. Bounded by each writer's `writeTimeoutMs`. Snapshot the ids
  // first — `clear()` empties the map below.
  const openDocIds = Array.from(openDocuments.keys());
  await Promise.all(
    openDocIds.map((docId) => cancelAndAwaitMarkdownWritesForDocument(docId)),
  );
  // Bind to the incoming vault so loadDocument refuses stale
  // outgoing-vault loads until vaultStore.path flips to it.
  documentStore.clear(event.nextVault);
});
