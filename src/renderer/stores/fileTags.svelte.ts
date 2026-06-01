/**
 * fileTagsStore — reactive Svelte 5 wrapper around `.filo/tags.json`.
 *
 * After the Obsidian-alignment pass, this is the single canonical tag store:
 *   - tag definitions (name → colour) — the only place colours live.
 *   - file-tag assignments (vault-relative path → tag-name array) — covers
 *     `.md`, attachments, and `.board.json` files alike.
 *   - tile-aware action helpers — addTagToTile / removeTagFromTile /
 *     renameTagEverywhere / removeTagEverywhere — coordinate tile.tags arrays
 *     on board files with frontmatter mirrors for text-backed tiles.
 *
 * Tag identity is the tag NAME (not an ID). `tile.tags: string[]` carries
 * names directly; the deleted `tagsStore` no longer exists.
 *
 * The store debounces writes to disk so a rapid UI interaction (e.g. adding
 * three tags through the popup) coalesces into one save.
 */

import { SvelteSet } from 'svelte/reactivity';
import type { TagsFile } from '../schema/tagsFile';
import type {
  Tile,
  TextTile,
  ImageTile,
  VideoTile,
  AudioTile,
  FileTile,
} from '../schema/index';
import {
  emptyTagsFile,
  loadTagsFile,
  type LoadTagsFileResult,
  tagsForFile as pureTagsForFile,
  filesForTag as pureFilesForTag,
  allTagNames as pureAllTagNames,
  getTagDefinition as pureGetTagDefinition,
  addTagToFile,
  removeTagFromFile,
  setFileTags,
  renameTag as pureRenameTag,
  deleteTag as pureDeleteTag,
  setTagColor as pureSetTagColor,
  dropFile,
  renameFile,
  renameFolderInTags,
  dropFolderInTags,
  canonicaliseTagName,
  pruneFileTagsAgainstKnownPaths,
  isValidTagName,
} from '../lib/vault/tagsStorage';
import {
  addTagToMarkdown,
  removeTagFromMarkdown,
} from '../lib/vault/tagRewriter';
import { tileBacksMarkdownPath } from '../lib/vault/frontmatterSync';
import { normalizeVaultRelative } from '../lib/utils/path';
import { vaultPath, type VaultPath } from '../../shared/vaultPath';
import {
  commitTagRenameInMemory,
  commitTagRemovalInMemory,
  pushTagRewriteFailureToast,
  flushTagRewriteBoardWrites,
  runTagRewriteSweep,
  rewriteAndCommitRetry,
} from './fileTagsCascade.svelte';
import type { TileDefinition } from '../schema/index';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { vaultStore } from './vault.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { documentStore } from './document.svelte';
import { historyStore } from './history.svelte';
import {
  ToggleTagFadeCommand,
  AddTileTagCommand,
  RemoveTileTagCommand,
  AddPathTagCommand,
  RemovePathTagCommand,
} from '../commands/index';
import { scheduleMiscWrite, flushAllMisc, flushMiscWrite, trackComponentWrite, markPathFailed } from '../lib/boards/boardSaver';
import { flushAllMarkdownWriters } from '../lib/vault/markdownFileWriter';
import { flushAllPendingFrontmatterWrites } from '../lib/boards/frontmatterWriteScheduler';
import { invokeOk } from '../lib/utils/invokeOk';
import { reportError } from '../lib/utils/errorBus';
import { uiStore } from './ui.svelte';
import { onVaultSwap, vaultSwapResettable } from '../core/vaultLifecycle';

let file = $state<TagsFile>(emptyTagsFile());
let isHydrated = $state(false);
let activeVaultRoot: string | null = null;

// F6 (2026-05-28) — true when the loaded `.filo/tags.json` was written by a
// newer Filo (or declares an un-migratable version). `scheduleSave` is then
// gated so we never re-save (downgrade) it. Set on every load path.
let readOnlyFromFuture = false;

const TAGS_WRITE_KEY = 'tags';
const TAGS_PATH = '.filo/tags.json';

function scheduleSave(): void {
  if (!activeVaultRoot) return;
  // F6 — never persist over a from-future / un-migratable tags file.
  if (readOnlyFromFuture) return;
  scheduleMiscWrite(TAGS_WRITE_KEY, () => {
    const root = activeVaultRoot;
    if (!root) return null;
    const snapshot = JSON.stringify(file, null, 2);
    return {
      vaultRoot: root,
      path: TAGS_PATH,
      write: async () => {
        // tags:save is documented as `throws on error` (no envelope).
        // Use bare invoke; the surrounding miscScheduler catches throws.
        await window.filo.invoke('tags:save', root, snapshot);
      },
    };
  });
}

/**
 * Resolves the vault-relative `.md` path for a text tile, mirroring the
 * resolution used by TextTile.svelte. Returns null when no path can be
 * inferred (no vault open, non-text tile, etc.).
 */
function resolveTextTileFilePath(tile: Tile): string | null {
  if (tile.type !== 'text') return null;
  if (!vaultStore.path) return null;
  const explicit = (tile as TextTile & { filePath?: string }).filePath;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const contentId = (tile as TextTile).contentId;
  const docState = contentId ? documentStore.getDocument(contentId) : null;
  return docState?.filename || `${tile.title || 'Untitled'}.md`;
}

/**
 * Resolves the vault-relative media path for an attachment tile (image,
 * video, audio, file). These tiles have no frontmatter sidecar, so their
 * tags live in `.filo/tags.json:fileTags[mediaPath]` directly — consistent
 * with the schema comment on `tagsFile.ts` ("Any file type may appear as a
 * key"). Returns null for non-attachment tiles or when the path is empty.
 */
function resolveTileMediaPath(tile: Tile): string | null {
  switch (tile.type) {
    case 'image':
    case 'video':
    case 'audio': {
      const src = (tile as ImageTile | VideoTile | AudioTile).src;
      return typeof src === 'string' && src.length > 0 ? src : null;
    }
    case 'file': {
      const filePath = (tile as FileTile).filePath;
      return typeof filePath === 'string' && filePath.length > 0 ? filePath : null;
    }
    default:
      return null;
  }
}

/**
 * Writes a single tag membership change into the tile's backing `.md` file
 * frontmatter. Routed through `trackComponentWrite` so a failed write
 * surfaces through the same toast + sentinel pipeline as the rest of the
 * per-component writers.
 */
async function writeTagChangeToTileMarkdown(
  tile: Tile,
  tagName: string,
  operation: 'add' | 'remove',
): Promise<void> {
  const vaultRoot = vaultStore.path;
  const relPath = resolveTextTileFilePath(tile);
  if (!vaultRoot || !relPath) return;

  try {
    // Phase 37 / 37.6 — canonical two-arg shape.
    let raw: string | null = null;
    try {
      const readResult = await invokeOk('vault:read-file-text', vaultRoot, relPath);
      raw = readResult.content;
    } catch {
      // Read failed (likely envelope-failure or transient I/O). Falls
      // through to the file-exists check below.
    }
    if (raw === null) {
      // Distinguish "file is gone" (a deletion the user expects) from "file
      // exists but we still couldn't read it" (a real I/O failure the user
      // needs to see). Only the second case keeps the sentinel dirty +
      // surfaces a toast — the first is a benign no-op so a delete + queued
      // tag write doesn't resurrect a deleted file's sentinel state.
      const exists = await window.filo.invoke('vault:file-exists', vaultRoot, relPath);
      if (exists) {
        markPathFailed(vaultRoot, relPath);
        reportError(
          'fileTags.writeTileFrontmatter',
          null,
          `Could not read ${relPath} to update frontmatter — your tag change is not on disk.`,
        );
      }
      return;
    }
    const next = operation === 'add'
      ? addTagToMarkdown(raw, tagName)
      : removeTagFromMarkdown(raw, tagName);
    if (next === raw) return;
    await trackComponentWrite(vaultRoot, relPath, async () => {
      // Phase 31 A4.5 — single-tag add/remove is an edit to an existing
      // .md file (raw was just read above). Use write-existing so a
      // race with an external delete surfaces as ENOENT rather than
      // resurrecting the deleted file.
      await invokeOk('vault:write-existing-file-text', vaultRoot, relPath, next); // allow-direct-write: inline-tag text rewrite (operates on raw markdown body, not a frontmatter+body assembly)
    });
    await vaultIndexStore.applyChanges([relPath]);
    // Phase 3 / 3.5 — read-only doc UX. The tag write went through
    // (frontmatter round-trips cleanly even when the body doesn't), but
    // the editor is held read-only because tiptap-markdown couldn't
    // round-trip the body syntax — meaning any local body edits the user
    // made in the editor are NOT being written back. Surface a toast so
    // the user understands why their body changes aren't on disk even
    // though the tag landed.
    surfaceReadOnlyTagToastIfNeeded(relPath);
  } catch (err) {
    // trackComponentWrite already surfaced the failure via the save-error
    // listener. Local catch keeps fire-and-forget callers from raising
    // unhandled rejections.
    reportError('fileTagsStore', err, `Failed to write tag change to ${relPath}`);
  }
}

/**
 * Phase 3 / 3.5 — fires the read-only tag toast when the file backing the
 * tag write has an open editor that's currently held read-only by the
 * lossy-round-trip sentinel. Deduped by `readOnlyTagToastShown` so a
 * batch of N tag operations against the same file doesn't push N toasts.
 *
 * Idempotent: re-entering after the toast has been shown does nothing
 * until the read-only flag is cleared (via the editor banner's "Take
 * ownership"). The dedupe Set is keyed by docId so the toast can re-fire
 * for the same path if the user reopens it under a fresh docId.
 *
 * Phase 6.1.R2 — reset on vault swap so a stale docId entry can't
 * suppress a legitimate toast in the new vault.
 */
const readOnlyTagToastShown = new SvelteSet<string>();
vaultSwapResettable('fileTags.readOnlyTagToastShown', () => readOnlyTagToastShown.clear());

function surfaceReadOnlyTagToastIfNeeded(relPath: string): void {
  const editorDoc = documentStore.findByFilename(relPath);
  if (!editorDoc) return;
  if (!documentStore.isReadOnly(editorDoc.docId)) {
    // Doc isn't read-only — drop any stale dedupe entry so a future
    // read-only flip surfaces the toast again.
    readOnlyTagToastShown.delete(editorDoc.docId);
    return;
  }
  if (readOnlyTagToastShown.has(editorDoc.docId)) return;
  readOnlyTagToastShown.add(editorDoc.docId);
  uiStore.toast(
    "Tag updated. Body changes were not saved because this file's Markdown isn't safe to round-trip.",
    'warning',
    6000,
  );
}

/**
 * Mirrors a single-tag add/remove to every OTHER text-tile def backed by
 * the same `.md` path. The originator tile has already had its `tags`
 * updated by the caller; this propagates the change to sibling tiles
 * (duplicates of the same file on this or another board) so the badge
 * footer matches across all views immediately. Without this, only the
 * originator updated reactively and siblings stayed visually stale until
 * the file watcher fired (or never, since renderer self-writes don't
 * always re-enter `handleExternalMarkdownChanges`).
 *
 * Uses `boardStore.updateTile` for active-board tiles (reactive UI path)
 * and `boardStore.persistUpdateTile` for tile defs on other boards — same
 * split used by `renameTagEverywhere` / `removeTagEverywhere`.
 *
 * Pass `originatorTileId = null` to update every tile backed by the path
 * (used by file-path mutations that originate outside any specific tile).
 */
function propagateTileTagChangeToSiblings(
  relPath: string,
  tagName: string,
  operation: 'add' | 'remove',
  originatorTileId: string | null,
): void {
  if (!relPath || !tagName) return;
  for (const def of Object.values(boardStore.allTileDefs)) {
    if (originatorTileId !== null && def.id === originatorTileId) continue;
    if (def.type !== 'text') continue;
    if (!tileBacksMarkdownPath(def as TileDefinition, relPath)) continue;
    const tags = def.tags ?? [];
    let nextTags: string[];
    if (operation === 'add') {
      if (tags.includes(tagName)) continue;
      nextTags = [...tags, tagName];
    } else {
      if (!tags.includes(tagName)) continue;
      nextTags = tags.filter((t) => t !== tagName);
    }
    if (boardStore.getTile(def.id)) {
      boardStore.updateTile(def.id, { tags: nextTags });
    } else {
      boardStore.persistUpdateTile(def.id, { tags: nextTags });
    }
  }
}

/**
 * File-path variant of `writeTagChangeToTileMarkdown`. Same three-sink
 * write — reads the backing `.md`, calls the pure rewriter, writes back
 * via IPC, then re-indexes — but driven by a vault-relative path rather
 * than a tile. Used by the Document board's tag strip and the sidebar
 * file editor, where the editing surface isn't a tile.
 */
async function writeTagChangeToMarkdownPath(
  relPath: string,
  tagName: string,
  operation: 'add' | 'remove',
): Promise<void> {
  const vaultRoot = vaultStore.path;
  if (!vaultRoot || !relPath) return;
  try {
    // Phase 37 / 37.6 — canonical two-arg shape.
    let raw: string | null = null;
    try {
      const readResult = await invokeOk('vault:read-file-text', vaultRoot, relPath);
      raw = readResult.content;
    } catch {
      // Read failed (likely envelope-failure or transient I/O). Falls
      // through to the file-exists check below.
    }
    if (raw === null) {
      // See writeTagChangeToTileMarkdown above: distinguish a real I/O
      // failure from a benign no-op when the file is gone. Keep the
      // sentinel dirty + surface a toast only when the file is still on
      // disk and the read failed for some other reason (permissions, etc.).
      const exists = await window.filo.invoke('vault:file-exists', vaultRoot, relPath);
      if (exists) {
        markPathFailed(vaultRoot, relPath);
        reportError(
          'fileTags.writePathFrontmatter',
          null,
          `Could not read ${relPath} to update frontmatter — your tag change is not on disk.`,
        );
      }
      return;
    }
    const next = operation === 'add'
      ? addTagToMarkdown(raw, tagName)
      : removeTagFromMarkdown(raw, tagName);
    if (next === raw) return;
    await trackComponentWrite(vaultRoot, relPath, async () => {
      // Phase 31 A4.5 — single-tag add/remove is an edit to an existing
      // .md file (raw was just read above). Use write-existing so a
      // race with an external delete surfaces as ENOENT rather than
      // resurrecting the deleted file.
      await invokeOk('vault:write-existing-file-text', vaultRoot, relPath, next); // allow-direct-write: inline-tag text rewrite (operates on raw markdown body, not a frontmatter+body assembly)
    });
    await vaultIndexStore.applyChanges([relPath]);
    // Phase 3 / 3.5 — same read-only doc UX as writeTagChangeToTileMarkdown.
    // The path-driven flow runs from the Document board tag strip and the
    // sidebar file editor; either can target a read-only doc and the user
    // needs to know body changes aren't being saved alongside the tag.
    surfaceReadOnlyTagToastIfNeeded(relPath);
  } catch (err) {
    reportError('fileTagsStore', err, `Failed to write tag change to ${relPath}`);
  }
}

export const fileTagsStore = {
  get file(): TagsFile { return file; },
  get isHydrated(): boolean { return isHydrated; },

  async hydrate(vaultRoot: string): Promise<void> {
    activeVaultRoot = vaultRoot;
    try {
      const raw = (await window.filo.invoke('tags:load', vaultRoot)) as string | null;
      const loaded = loadTagsFile(raw);
      file = loaded.file;
      readOnlyFromFuture = loaded.fromFuture || loaded.noMigrationPath;
    } catch (err) {
      reportError(
        'fileTags.hydrate',
        err,
        'Failed to load .filo/tags.json — tags reset to empty for this session',
      );
      file = emptyTagsFile();
      readOnlyFromFuture = false;
    }
    isHydrated = true;
  },

  /**
   * Phase R4 — synchronous commit hook for `loadVaultCandidate`.
   *
   * Installs a `TagsFile` that the candidate phase already loaded over
   * IPC. No throw, no IPC; the load happened (and any error surfaced)
   * during the candidate phase. Mirrors the `hydrate` post-state but
   * skips the I/O so the commit boundary stays synchronous.
   */
  commitFromCandidate(vaultRoot: string, tagsFile: TagsFile, readOnly = false): void {
    activeVaultRoot = vaultRoot;
    file = tagsFile;
    // F6 — the candidate phase already ran the version migrator; carry its
    // read-only verdict so a from-future tags file isn't re-saved.
    readOnlyFromFuture = readOnly;
    isHydrated = true;
  },

  isEmpty(): boolean {
    return Object.keys(file.tags).length === 0 && Object.keys(file.fileTags).length === 0;
  },

  /**
   * Phase 23 M13 — drops `fileTags[*]` entries whose vault-relative path is
   * not in `knownPaths`. Run after vault open once the file tree is loaded
   * so external deletions / moves that happened while Filo was closed don't
   * keep orphan attachment tag entries around. Returns the dropped paths so
   * the caller can surface a one-shot toast if anything was pruned.
   *
   * The match is case-insensitive (mirrors `flattenTreePaths`'s on-disk-case
   * producer convention) — Windows/macOS users routinely have a single file
   * recorded with a case variant the live tree no longer carries.
   */
  pruneOrphanFileTags(knownPaths: ReadonlySet<string>): string[] {
    const result = pruneFileTagsAgainstKnownPaths(file, knownPaths);
    if (result.droppedPaths.length === 0) return [];
    file = result.file;
    scheduleSave();
    return result.droppedPaths;
  },

  /**
   * Counts tag references on disk that have no matching registry definition.
   * A non-zero count means `.filo/tags.json` and the rest of the vault have
   * drifted apart — typically because a rename/delete sweep failed partway,
   * or the user edited `.filo/tags.json` by hand.
   *
   * Returns `tile` (references on tile defs across every loaded board) and
   * `file` (references inside `fileTags[*]`). Read-only — does not mutate.
   * Called once on vault open; the resulting count drives a one-shot toast.
   */
  detectOrphans(): { tile: number; file: number } {
    const knownLower = new SvelteSet<string>();
    for (const name of Object.keys(file.tags)) knownLower.add(name.toLowerCase());

    let tile = 0;
    for (const def of Object.values(boardCacheStore.allTileDefs)) {
      const tags = (def as { tags?: string[] }).tags;
      if (!Array.isArray(tags)) continue;
      for (const t of tags) {
        if (!knownLower.has(t.toLowerCase())) tile++;
      }
    }

    let fileCount = 0;
    for (const tags of Object.values(file.fileTags)) {
      for (const t of tags) {
        if (!knownLower.has(t.toLowerCase())) fileCount++;
      }
    }

    return { tile, file: fileCount };
  },

  setAll(next: TagsFile): void {
    file = next;
    scheduleSave();
  },

  /**
   * F6 — applies a tags file re-read after an external `.filo/tags.json`
   * edit, carrying the migrator's read-only verdict so a from-future file
   * flips the store read-only (gating `scheduleSave`). A current-version
   * file behaves exactly like `setAll`.
   */
  applyExternalReload(loaded: LoadTagsFileResult): void {
    file = loaded.file;
    readOnlyFromFuture = loaded.fromFuture || loaded.noMigrationPath;
    scheduleSave();
  },

  reset(): void {
    activeVaultRoot = null;
    isHydrated = false;
    file = emptyTagsFile();
    readOnlyFromFuture = false;
  },

  /** Forces a synchronous write of any pending debounced save. */
  async flush(): Promise<void> {
    await flushAllMisc();
  },

  // ── Read-side ──────────────────────────────────────────────────────────────

  tagsForFile(path: string): string[] {
    return pureTagsForFile(file, path);
  },

  filesForTag(tagName: string): string[] {
    return pureFilesForTag(file, tagName);
  },

  allTagNames(): string[] {
    return pureAllTagNames(file);
  },

  getDefinition(tagName: string) {
    return pureGetTagDefinition(file, tagName);
  },

  /**
   * Returns every tile across the project that carries the given tag name.
   * Scans vault-backed tile definitions and inline tiles (link / iframe /
   * timer) embedded in `project.boards[*].inlineTiles`.
   */
  getTilesWithTag(tagName: string): Array<{ id: string; type: string; title: string; tags: string[] }> {
    const results: Array<{ id: string; type: string; title: string; tags: string[] }> = [];

    for (const def of Object.values(boardStore.allTileDefs)) {
      if (def.tags?.includes(tagName)) {
        results.push({ id: def.id, type: def.type, title: def.title, tags: def.tags });
      }
    }

    const project = vaultStore.project;
    if (project) {
      for (const board of project.boards) {
        const inlineTiles = (board as { inlineTiles?: Record<string, unknown> }).inlineTiles ?? {};
        for (const tile of Object.values(inlineTiles)) {
          const t = tile as { id: string; type: string; title?: string; tags?: string[] };
          if (Array.isArray(t.tags) && t.tags.includes(tagName)) {
            results.push({ id: t.id, type: t.type, title: t.title ?? '', tags: t.tags });
          }
        }
      }
    }

    return results;
  },

  /**
   * Returns vault files carrying the given tag name (from `.filo/tags.json`)
   * minus any path already represented in a placed text tile (those are
   * already shown in the tiles section of the Tag popup).
   */
  getFilesWithTag(
    tagName: string,
    excludePaths: Set<string> = new SvelteSet(),
  ): Array<{ path: string; title: string; tags: string[] }> {
    if (!tagName) return [];
    const normExcluded = new SvelteSet(
      Array.from(excludePaths).map((p) => normalizeVaultRelative(p)),
    );
    const out: Array<{ path: string; title: string; tags: string[] }> = [];
    for (const path of this.filesForTag(tagName)) {
      const normPath = normalizeVaultRelative(path);
      if (normExcluded.has(normPath)) continue;
      const meta = vaultIndexStore.getMetadata(path);
      const title = meta?.title ?? (path.split('/').pop()?.replace(/\.md$/i, '') ?? path);
      out.push({ path, title, tags: meta?.tags ?? [tagName] });
    }
    return out;
  },

  getTagUsageCount(tagName: string): number {
    const tiles = this.getTilesWithTag(tagName).length;
    // Dedup files-section against placed tile paths so a tile and its backing
    // file aren't double-counted. After A1, attachment tiles also register
    // their media path in `fileTags`, so include those alongside text tiles.
    const placedPaths = new SvelteSet<VaultPath>();
    for (const def of Object.values(boardStore.allTileDefs)) {
      if (!def.tags?.includes(tagName)) continue;
      const tile = def as Tile;
      const textPath = resolveTextTileFilePath(tile);
      if (textPath) placedPaths.add(vaultPath(textPath));
      const mediaPath = resolveTileMediaPath(tile);
      if (mediaPath) placedPaths.add(vaultPath(mediaPath));
    }
    const files = this.getFilesWithTag(tagName, placedPaths).length;
    return tiles + files;
  },

  // ── File-tag mutations ────────────────────────────────────────────────────

  addTagToFile(path: string, tagName: string): void {
    const next = addTagToFile(file, path, tagName);
    if (next === file) return;
    file = next;
    scheduleSave();
  },

  removeTagFromFile(path: string, tagName: string): void {
    const next = removeTagFromFile(file, path, tagName);
    if (next === file) return;
    file = next;
    scheduleSave();
  },

  setFileTags(path: string, tags: string[]): void {
    const next = setFileTags(file, path, tags);
    if (next === file) return;
    file = next;
    scheduleSave();
  },

  /**
   * Renames a tag in `.filo/tags.json` only. Use `renameTagEverywhere` to
   * also propagate the change to tile entries on boards and to `.md` file
   * frontmatter.
   */
  renameTag(oldName: string, newName: string): string[] {
    const { file: next, touchedPaths } = pureRenameTag(file, oldName, newName);
    if (next === file) return [];
    file = next;
    scheduleSave();
    return touchedPaths;
  },

  /**
   * Deletes a tag from `.filo/tags.json` only. Use `removeTagEverywhere` to
   * also strip the tag from tile entries and `.md` frontmatter.
   */
  deleteTag(tagName: string): string[] {
    const { file: next, touchedPaths } = pureDeleteTag(file, tagName);
    if (next === file) return [];
    file = next;
    scheduleSave();
    return touchedPaths;
  },

  setTagColor(tagName: string, color: string): void {
    const next = pureSetTagColor(file, tagName, color);
    if (next === file) return;
    file = next;
    scheduleSave();
  },

  /**
   * Ensures a tag has a definition entry (so subsequent colour lookups
   * resolve). Idempotent.
   *
   * Sprint B / B6 — rejects tag names that wouldn't survive a YAML
   * frontmatter round-trip (internal whitespace splits into two tags, empty
   * names produce undefined registry keys). The UI-facing call sites
   * (TagEditor.commitTag) toast before reaching here; this is the
   * defence-in-depth gate for programmatic callers that bypassed the UI.
   */
  ensureTag(tagName: string, color?: string): void {
    if (!tagName) return;
    if (!isValidTagName(tagName)) return;
    if (file.tags[tagName]) return;
    const def = { color: color ?? '#3a86ff', createdAt: Date.now() };
    file = { ...file, tags: { ...file.tags, [tagName]: def } };
    scheduleSave();
  },

  dropFile(path: string): void {
    const next = dropFile(file, path);
    if (next === file) return;
    file = next;
    scheduleSave();
  },

  renameFile(oldPath: string, newPath: string): void {
    const next = renameFile(file, oldPath, newPath);
    if (next === file) return;
    file = next;
    scheduleSave();
  },

  /**
   * Folder-scoped variants of {@link renameFile} / {@link dropFile}. Used by
   * the vault rename/delete cascade so that renaming or deleting a folder
   * cascades into every tagged file nested under it. Files inside that
   * folder don't move/disappear individually — the OS-level folder
   * operation acts on them in one shot — so we have to rewrite or drop
   * their keys in `.filo/tags.json` ourselves.
   *
   * Safe to call alongside the per-file `renameFile`/`dropFile` variants:
   * a file rename uses exact-match keys that the folder helpers never touch,
   * and a folder rename leaves the exact-match call as a no-op.
   */
  renameFolder(oldPrefix: string, newPrefix: string): void {
    const next = renameFolderInTags(file, oldPrefix, newPrefix);
    if (next === file) return;
    file = next;
    scheduleSave();
  },

  dropFolder(prefix: string): void {
    const next = dropFolderInTags(file, prefix);
    if (next === file) return;
    file = next;
    scheduleSave();
  },

  /**
   * F3 (2026-05-28) — drains the debounced `.filo/tags.json` write
   * immediately and awaits it. The rename cascade calls this right after its
   * in-memory `renameFile` / `renameFolder` so the tag-membership rename
   * lands on disk synchronously, in the same critical section as the awaited
   * board flush. Without it the tag write sat on the 300ms misc debounce: a
   * crash between the board flush and that debounce firing would leave
   * `tags.json` keyed by the OLD path while every `.board.json` already
   * pointed at the new one — silent tag-membership loss the (board-only)
   * rename-cascade sentinel can't recover.
   *
   * No-op (resolves `{ ok: true }`) when no save is pending.
   */
  async flushPendingSave(): Promise<{ ok: boolean }> {
    return flushMiscWrite(TAGS_WRITE_KEY);
  },

  // ── Tile-aware mutations ──────────────────────────────────────────────────

  /**
   * Adds a tag to a tile by name. Updates the tile's `tags` array on the
   * board file and (for text tiles backed by a `.md` file) mirrors the tag
   * into the file's YAML frontmatter and into `.filo/tags.json:fileTags`.
   * Idempotent — adding a tag a tile already carries is a no-op.
   */
  addTagToTile(tileId: string, tagName: string): void {
    // Validate and canonicalise upfront so a no-op never reaches history.
    const liveTile = boardStore.getTile(tileId);
    const tile = liveTile ?? (boardStore.allTileDefs[tileId] as Tile | undefined);
    if (!tile || !tagName) return;
    const trimmed = canonicaliseTagName(file, tagName);
    if (!trimmed || tile.tags.includes(trimmed)) return;
    // Push an undoable command so Ctrl+Z reverses the tag add. Global tag
    // rename remains excluded from history (see `renameTag` — multi-file
    // disk-write batch is too coarse-grained for a single command). Phase 16/H2.
    historyStore.execute(new AddTileTagCommand(tileId, trimmed));
  },

  /**
   * Removes a tag from a tile. For text-backed tiles, also strips the tag
   * from the file's frontmatter and from `.filo/tags.json:fileTags[path]`.
   */
  removeTagFromTile(tileId: string, tagName: string): void {
    const liveTile = boardStore.getTile(tileId);
    const tile = liveTile ?? (boardStore.allTileDefs[tileId] as Tile | undefined);
    if (!tile || !tile.tags.includes(tagName)) return;
    historyStore.execute(new RemoveTileTagCommand(tileId, tagName));
  },

  /**
   * Internal impl of `addTagToTile` — no history push. Called by
   * `AddTileTagCommand.execute()` and `RemoveTileTagCommand.undo()`.
   * Mirrors `addTagToTile`'s old body, including the live-tile / tile-def
   * cache fallback for Kanban Card / Task surfaces.
   */
  _applyAddTagToTile(tileId: string, tagName: string): void {
    const liveTile = boardStore.getTile(tileId);
    const tile = liveTile ?? (boardStore.allTileDefs[tileId] as Tile | undefined);
    if (!tile || tile.tags.includes(tagName)) return;
    if (liveTile) {
      boardStore.updateTile(tileId, { tags: [...tile.tags, tagName] });
    } else {
      boardStore.persistUpdateTile(tileId, { tags: [...tile.tags, tagName] });
    }
    this.ensureTag(tagName);
    if (tile.type === 'text') {
      const path = resolveTextTileFilePath(tile);
      if (path) {
        this.addTagToFile(path, tagName);
        propagateTileTagChangeToSiblings(path, tagName, 'add', tile.id);
      }
      void writeTagChangeToTileMarkdown(tile, tagName, 'add');
      return;
    }
    const mediaPath = resolveTileMediaPath(tile);
    if (mediaPath) {
      this.addTagToFile(mediaPath, tagName);
    }
  },

  /**
   * Internal impl of `removeTagFromTile` — no history push.
   */
  _applyRemoveTagFromTile(tileId: string, tagName: string): void {
    const liveTile = boardStore.getTile(tileId);
    const tile = liveTile ?? (boardStore.allTileDefs[tileId] as Tile | undefined);
    if (!tile || !tile.tags.includes(tagName)) return;
    const nextTags = tile.tags.filter((t) => t !== tagName);
    if (liveTile) {
      boardStore.updateTile(tileId, { tags: nextTags });
    } else {
      boardStore.persistUpdateTile(tileId, { tags: nextTags });
    }
    if (tile.type === 'text') {
      const path = resolveTextTileFilePath(tile);
      if (path) {
        this.removeTagFromFile(path, tagName);
        propagateTileTagChangeToSiblings(path, tagName, 'remove', tile.id);
      }
      void writeTagChangeToTileMarkdown(tile, tagName, 'remove');
      return;
    }
    const mediaPath = resolveTileMediaPath(tile);
    if (mediaPath) {
      this.removeTagFromFile(mediaPath, tagName);
    }
  },

  /**
   * File-path counterpart of `addTagToTile` — same three sinks, but the
   * editing surface is a `.md` file (Document board, sidebar) rather than
   * a specific tile. Updates `.filo/tags.json:fileTags`, every text-tile
   * def backed by that path, and the file's frontmatter. Idempotent.
   */
  addTagToPath(path: string, tagName: string): void {
    if (!path) return;
    const trimmed = canonicaliseTagName(file, tagName ?? '');
    if (!trimmed) return;
    if (this.tagsForFile(path).includes(trimmed)) return;
    // Phase 7 / 7.8 — push an undoable command so Ctrl+Z reverses the add.
    // Mirrors `addTagToTile` (Phase 16/H2).
    historyStore.execute(new AddPathTagCommand(path, trimmed));
  },

  /**
   * File-path counterpart of `removeTagFromTile`. Strips the tag from the
   * three sinks. Idempotent.
   */
  removeTagFromPath(path: string, tagName: string): void {
    if (!path || !tagName) return;
    if (!this.tagsForFile(path).includes(tagName)) return;
    historyStore.execute(new RemovePathTagCommand(path, tagName));
  },

  /**
   * Internal impl of `addTagToPath` — no history push. Called by
   * `AddPathTagCommand.execute()` and `RemovePathTagCommand.undo()`.
   * Mirrors `_applyAddTagToTile` (Phase 16/H2).
   */
  _applyAddTagToPath(path: string, tagName: string): void {
    if (!path) return;
    const trimmed = canonicaliseTagName(file, tagName ?? '');
    if (!trimmed) return;
    if (this.tagsForFile(path).includes(trimmed)) return;
    this.ensureTag(trimmed);
    this.addTagToFile(path, trimmed);
    propagateTileTagChangeToSiblings(path, trimmed, 'add', null);
    void writeTagChangeToMarkdownPath(path, trimmed, 'add');
  },

  /**
   * Internal impl of `removeTagFromPath` — no history push.
   */
  _applyRemoveTagFromPath(path: string, tagName: string): void {
    if (!path || !tagName) return;
    if (!this.tagsForFile(path).includes(tagName)) return;
    this.removeTagFromFile(path, tagName);
    propagateTileTagChangeToSiblings(path, tagName, 'remove', null);
    void writeTagChangeToMarkdownPath(path, tagName, 'remove');
  },

  /**
   * Renames a tag everywhere: `.filo/tags.json` (definition + fileTags),
   * tile entries on every board, saved-view + lastView filter chips, and
   * `.md` frontmatter. Used by the Tag Browser's rename button.
   *
   * Awaits `boardCacheStore.ensureAllLoaded()` so the cascade reaches
   * every `.board.json` in the vault, not just those currently hydrated.
   * Under normal operation the cache is fully hydrated at vault open, so
   * the await is effectively free.
   *
   * Atomicity (Phase 9.1): `.md` frontmatter rewrites run *first*. The
   * registry, tile-def, inline-tile, and board-settings rewrites only
   * commit if every `.md` write succeeded. On partial failure the
   * in-memory state stays at the old name and the toast offers a retry
   * scoped to the unwritten files — re-running with the same arguments
   * naturally targets only those, since the metadata of the succeeded
   * files no longer mentions `oldName`.
   */
  async renameTagEverywhere(oldName: string, newName: string): Promise<void> {
    const trimmed = newName.trim();
    if (!oldName || !trimmed || oldName === trimmed) return;

    await boardCacheStore.ensureAllLoaded();

    // Phase 31 A3.3 — drain pending per-file markdown / frontmatter
    // debouncers BEFORE the rewrite sweep reads metadata. Without this,
    // a TextTile that the user JUST edited but hasn't flushed (still
    // inside the 300 ms debounce) would have its tag-set rewritten back
    // to the OLD name when the debounce fires after the sweep finishes:
    // the sweep walks vaultIndex metadata (which reflects the on-disk
    // file from before the user's last edit) and re-asserts that
    // outdated state on disk. Flushing first ensures the sweep walks
    // the latest user state.
    const mdResult = await flushAllMarkdownWriters();
    const fmResult = await flushAllPendingFrontmatterWrites();
    if (mdResult.failed.length > 0 || fmResult.failed.length > 0) {
      const failedPaths = [
        ...mdResult.failed.map((f) => f.ownerId),
        ...fmResult.failed,
      ];
      uiStore.pushToast({
        text: `Tag rename aborted — could not flush pending edits to ${failedPaths.length} file${failedPaths.length === 1 ? '' : 's'}. Resolve the per-file errors above and try again.`,
        type: 'error',
        duration: 0,
      });
      return;
    }

    const result = await runTagRewriteSweep(oldName, trimmed);
    if (result.failed.length > 0) {
      const failedSet = new SvelteSet(result.failed);
      pushTagRewriteFailureToast({
        verb: 'Tag rename',
        failedCount: result.failed.length,
        attempted: result.attempted,
        retry: () => rewriteAndCommitRetry(this, oldName, trimmed, failedSet),
      });
      return;
    }

    commitTagRenameInMemory(this, oldName, trimmed);
    // Phase 4.3 (2026-05-30) — flush the debounced registry write before the board flush so a crash can't strand the renamed tag on disk without its tags.json definition (mirrors 4.1 / F3).
    await this.flushPendingSave();
    // Phase 23 M11 — flush the cascaded board writes so a `.board.json`
    // failure is reported through the same toast surface as the .md
    // failures above (currently the boards would only retry silently via
    // the recovery sentinel on next save).
    await flushTagRewriteBoardWrites('Tag rename');
  },

  /**
   * Removes a tag everywhere: definition + file assignments + tile entries
   * + saved-view + lastView filter chips + `.md` frontmatter.
   *
   * See {@link renameTagEverywhere} for the atomicity rationale — same
   * shape applies here.
   */
  async removeTagEverywhere(tagName: string): Promise<void> {
    if (!tagName) return;

    await boardCacheStore.ensureAllLoaded();

    // Phase 31 A3.3 — see renameTagEverywhere for the rationale on
    // flushing the per-file markdown / frontmatter debouncers before
    // the sweep reads the canonical vaultIndex metadata.
    const mdResult = await flushAllMarkdownWriters();
    const fmResult = await flushAllPendingFrontmatterWrites();
    if (mdResult.failed.length > 0 || fmResult.failed.length > 0) {
      const failedPaths = [
        ...mdResult.failed.map((f) => f.ownerId),
        ...fmResult.failed,
      ];
      uiStore.pushToast({
        text: `Tag removal aborted — could not flush pending edits to ${failedPaths.length} file${failedPaths.length === 1 ? '' : 's'}. Resolve the per-file errors above and try again.`,
        type: 'error',
        duration: 0,
      });
      return;
    }

    const result = await runTagRewriteSweep(tagName, null);
    if (result.failed.length > 0) {
      const failedSet = new SvelteSet(result.failed);
      pushTagRewriteFailureToast({
        verb: 'Tag removal',
        failedCount: result.failed.length,
        attempted: result.attempted,
        retry: () => rewriteAndCommitRetry(this, tagName, null, failedSet),
      });
      return;
    }

    commitTagRemovalInMemory(this, tagName);
    // Phase 4.3 (2026-05-30) — see renameTagEverywhere; flush before the board flush.
    await this.flushPendingSave();
    // Phase 23 M11 — see renameTagEverywhere for the rationale on flushing.
    await flushTagRewriteBoardWrites('Tag removal');
  },

  /**
   * Toggles faded state for every tile on the current board that carries
   * the given tag. Uses history for undo support.
   */
  toggleTagFade(tagName: string): void {
    const tilesWithTag = Object.values(boardStore.tiles).filter((t) => t.tags.includes(tagName));
    if (tilesWithTag.length === 0) return;
    const anyVisible = tilesWithTag.some((t) => !t.faded);
    const cmd = new ToggleTagFadeCommand(
      tilesWithTag.map((t) => t.id),
      anyVisible,
      tagName,
    );
    historyStore.execute(cmd);
  },

};

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Drops the hydrated tag registry + file-tag assignments so the new vault's
// `.filo/tags.json` doesn't merge with stale entries from the prior vault.
onVaultSwap('pre-swap', 'fileTags', () => {
  fileTagsStore.reset();
});
