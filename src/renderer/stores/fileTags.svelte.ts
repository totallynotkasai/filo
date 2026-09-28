/**
 * fileTagsStore — reactive Svelte 5 wrapper around `.filo/tags.json`.
 *
 * Where a tag lives depends on what carries it, and each has one copy:
 *   - a note's tags: its frontmatter `tags:` (never here);
 *   - a media or other non-Markdown file's tags: `fileTags[path]` here;
 *   - a board-only tile's tags (link / iframe / timer): the tile on its board.
 *
 * This store also owns the tag definitions (name → colour), the only place
 * colours live, and the actions that edit tags wherever they live —
 * addTagToTile / addTagToPath (and removals), renameTagEverywhere /
 * removeTagEverywhere.
 *
 * Tag identity is the tag NAME (not an ID).
 *
 * The store debounces writes to disk so a rapid UI interaction (e.g. adding
 * three tags through the popup) coalesces into one save.
 */

import { SvelteSet } from 'svelte/reactivity';
import type { TagsFile } from '../schema/tagsFile';
import type {
  Tile,
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
import { normalizeVaultRelative } from '../lib/utils/path';
import { isMarkdownExtension } from '../lib/vault/extension';
import { noteTags, noteTitle, registerMediaTagsReader } from './noteMeta';
import { writeTagChangeToMarkdownPath } from '../lib/tags/noteTagWriter';
import { vaultPath, type VaultPath } from '../../shared/vaultPath';
import {
  commitTagRenameInMemory,
  commitTagRemovalInMemory,
  pushTagRewriteFailureToast,
  flushTagRewriteBoardWrites,
  runTagRewriteSweep,
  rewriteAndCommitRetry,
  iterateBoardOnlyTiles,
} from './fileTagsCascade.svelte';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { historyStore } from './history.svelte';
import {
  ToggleTagFadeCommand,
  AddTileTagCommand,
  RemoveTileTagCommand,
  AddPathTagCommand,
  RemovePathTagCommand,
} from '../commands/index';
import { scheduleMiscWrite, flushAllMisc, flushMiscWrite } from '../lib/boards/boardSaver';
import { noteStore } from './notes.svelte';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { assertIpcOk } from '@shared/ipcEnvelope';
import { reportError } from '../lib/utils/errorBus';
import { uiStore } from './ui.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';
import { cloneTagsFile, sameJson, mergeTagsThreeWay } from '../lib/vault/tagsFileMerge';
import { countTagUsage, type TagCounts } from '../lib/tags/tagBrowserFilter';
import { sameTag } from '../lib/vault/sidebarTagFilter';

let file = $state<TagsFile>(emptyTagsFile());
let isHydrated = $state(false);
let activeVaultRoot: string | null = null;

/**
 * The last `.filo/tags.json` state Filo loaded from / persisted to disk
 * (the common ancestor `applyExternalReload`'s 3-way merge diffs against). Kept
 * as an independent clone so in-memory mutations to `file` never alias it.
 * Updated at hydrate / candidate-commit, on a successful debounced save, on an
 * external reload (to the external disk copy), and cleared on reset.
 */
let lastSavedFile: TagsFile = emptyTagsFile();

/**
 * Guard token bumped by `setMergeBase` on every OUTSIDE re-set of the 3-way
 * merge base. The debounced save closure captures it at fire time to detect a
 * reload/swap that landed during its `tags:save` await (see `scheduleSave`).
 */
let mergeBaseGeneration = 0;

/**
 * Assigns the 3-way merge base and bumps the guard token. Every base re-set
 * from OUTSIDE the debounced save closure (hydrate, candidate-commit, external
 * reload, reset) routes through here so an in-flight save can detect it was
 * superseded and skip its own now-stale base update.
 */
function setMergeBase(next: TagsFile): void {
  lastSavedFile = next;
  mergeBaseGeneration += 1;
}

// True when the loaded `.filo/tags.json` must NOT be re-saved: written by a
// newer Filo, an un-migratable version, or a corrupt (parse/schema-fail) file.
// `scheduleSave` is gated on it so we never overwrite the on-disk bytes.
let readOnlyTags = false;

const TAGS_WRITE_KEY = 'tags';
const TAGS_PATH = '.filo/tags.json';

function scheduleSave(): void {
  if (!activeVaultRoot) return;
  // Never persist over a from-future / un-migratable / corrupt tags file (the
  // disk bytes are preserved verbatim for the session).
  if (readOnlyTags) return;
  scheduleMiscWrite(TAGS_WRITE_KEY, () => {
    const root = activeVaultRoot;
    if (!root) return null;
    const identity = captureVaultIdentity();
    let snapshot = JSON.stringify(file, null, 2);
    // Capture the merge-base token at fire time (alongside the snapshot). The trailing assignment below only lands if no reload/reset
    // advanced it during the await.
    const baseGenAtFire = mergeBaseGeneration;
    return {
      vaultRoot: root,
      path: TAGS_PATH,
      json: snapshot,
      write: async () => {
        // Merge on write. Another machine's tags.json can land inside the
        // self-write window (its watcher event is dropped as our echo), so a
        // blind save would overwrite its registrations. Re-read disk first; if
        // it moved off our merge base, 3-way merge (a same-key conflict goes to ours).
        const raw: unknown = assertIpcOk(await window.filo.invoke('tags:load', root), 'tags:load');
        if (!isStillSameVault(identity)) return;
        // A reload/reset re-set the base during the read: it merged our
        // snapshot's delta into memory and re-armed its own save.
        if (mergeBaseGeneration !== baseGenAtFire) return;
        // DECISION: an absent file (null) is written as-is, not merged — a
        // sync hiccup that briefly removes tags.json must not read as "the
        // other side deleted every tag".
        if (typeof raw === 'string') {
          const disk = loadTagsFile(raw);
          if (disk.fromFuture || disk.noMigrationPath || disk.corrupt) {
            readOnlyTags = true; // never overwrite it
            throw Object.assign(new Error('.filo/tags.json on disk is unreadable or from a newer Filo'), {
              code: 'CONFIG_CORRUPT',
            });
          }
          if (!sameJson(disk.file, lastSavedFile)) {
            file = mergeTagsThreeWay(lastSavedFile, file, disk.file);
            snapshot = JSON.stringify(mergeTagsThreeWay(lastSavedFile, JSON.parse(snapshot) as TagsFile, disk.file), null, 2);
          }
        }
        // tags:save resolves `{ ok:false }` on failure; assertIpcOk re-throws so
        // the miscScheduler's catch records it (dirty-flag + retry).
        assertIpcOk(await window.filo.invoke('tags:save', root, snapshot), 'tags:save');
        // Record what landed on disk as the new merge base (success only), so a
        // later external reload diffs against it. Skip when a concurrent
        // reload/reset advanced the base during the await: clobbering its fresh
        // base would desync the next 3-way diff (the reload re-armed its own save).
        // Deliberately a bare assignment, NOT setMergeBase — overlapping
        // same-vault saves each record their own bytes; only OUTSIDE re-sets
        // bump the token.
        if (mergeBaseGeneration === baseGenAtFire) {
          lastSavedFile = JSON.parse(snapshot) as TagsFile;
        }
      },
    };
  });
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

/** True for a path whose tags live in its own frontmatter. */
function isNotePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && isMarkdownExtension(path.slice(dot));
}

/**
 * The runtime tile for `tileId`, whichever board holds it: the active board's
 * tile when it's there, else the tile derived from its board's cache. Either
 * way its `tags` / `title` are read from where they live.
 */
function findTile(tileId: string): Tile | undefined {
  const live = boardStore.getTile(tileId);
  if (live) return live;
  const boardId = boardCacheStore.findTileBoardId(tileId);
  return boardId ? boardCacheStore.getFullTilesForBoard(boardId)[tileId] : undefined;
}

/** The file that carries a tile's tags, or `null` for a board-only tile. */
function tagFileOfTile(tile: Tile): string | null {
  if (tile.type === 'text') return tile.filePath || null;
  return resolveTileMediaPath(tile);
}

/** A tile carrying a tag, with the board it sits on (so a click can go there). */
export interface TaggedTile {
  id: string;
  boardId: string;
  type: string;
  title: string;
  tags: string[];
  path: string | null;
}

/**
 * What a vault-wide tag rename or removal did. `committed` is false when it
 * stopped before changing the registry and boards (a failed flush or sweep,
 * which offers its own retry); `writtenPaths` are the notes it rewrote.
 */
export interface TagSweepOutcome {
  committed: boolean;
  writtenPaths: string[];
}
function notCommitted(): TagSweepOutcome {
  return { committed: false, writtenPaths: [] };
}

export const fileTagsStore = {
  get file(): TagsFile { return file; },
  get isHydrated(): boolean { return isHydrated; },

  async hydrate(vaultRoot: string): Promise<void> {
    activeVaultRoot = vaultRoot;
    try {
      // assertIpcOk re-throws a `{ ok:false }` envelope into the catch below.
      const raw = assertIpcOk(await window.filo.invoke('tags:load', vaultRoot), 'tags:load') as string | null;
      const loaded = loadTagsFile(raw);
      file = loaded.file;
      setMergeBase(cloneTagsFile(loaded.file)); // disk baseline
      readOnlyTags = loaded.fromFuture || loaded.noMigrationPath || loaded.corrupt;
    } catch (err) {
      reportError(
        'fileTags.hydrate',
        err,
        'Failed to load .filo/tags.json — tags reset to empty for this session',
      );
      file = emptyTagsFile();
      setMergeBase(emptyTagsFile());
      readOnlyTags = false;
    }
    isHydrated = true;
  },

  /**
   * Synchronous commit hook for `loadVaultCandidate`.
   *
   * Installs a `TagsFile` that the candidate phase already loaded over
   * IPC. No throw, no IPC; the load happened (and any error surfaced)
   * during the candidate phase. Mirrors the `hydrate` post-state but
   * skips the I/O so the commit boundary stays synchronous.
   */
  commitFromCandidate(vaultRoot: string, tagsFile: TagsFile, readOnly = false): void {
    activeVaultRoot = vaultRoot;
    file = tagsFile;
    setMergeBase(cloneTagsFile(tagsFile)); // disk baseline
    // Carry the candidate phase's read-only verdict so a from-future /
    // un-migratable / corrupt file isn't re-saved.
    readOnlyTags = readOnly;
    isHydrated = true;
  },

  isEmpty(): boolean {
    return Object.keys(file.tags).length === 0 && Object.keys(file.fileTags).length === 0;
  },

  /**
   * Drops `fileTags[*]` entries whose vault-relative path is
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
   * Returns `tile` (references on board-only tiles across every loaded
   * board) and `file` (references inside `fileTags[*]`). A note's frontmatter
   * tags are the user's own content and aren't counted. Read-only — does not
   * mutate. Called once on vault open; the count drives a one-shot toast.
   */
  detectOrphans(): { tile: number; file: number } {
    const knownLower = new SvelteSet<string>();
    for (const name of Object.keys(file.tags)) knownLower.add(name.toLowerCase());

    let tile = 0;
    for (const t of iterateBoardOnlyTiles()) {
      for (const tag of t.tags) {
        if (!knownLower.has(tag.toLowerCase())) tile++;
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

  /** True when `disk` is exactly what Filo last loaded/saved (our own echo). */
  isLastSavedState(disk: TagsFile): boolean {
    return sameJson(disk, lastSavedFile);
  },

  /**
   * Applies a tags file re-read after an external `.filo/tags.json` edit,
   * carrying the migrator's read-only verdict so a from-future file flips the
   * store read-only (gating `scheduleSave`). Returns `false` (caller skips the
   * toast) when disk deep-equals our in-memory registry — a self-write echo in
   * the 30 s reconcile pass, not an external edit.
   */
  applyExternalReload(loaded: LoadTagsFileResult): boolean {
    const diskDiffersFromMemory = !sameJson(loaded.file, file);
    // 3-way merge, not wholesale overwrite: a tag add/remove still in the save
    // debounce (attachment tags have no other home) would otherwise be lost.
    file = mergeTagsThreeWay(lastSavedFile, file, loaded.file);
    // Bump the merge-base token so an in-flight `tags:save` can't clobber this
    // fresh base back to its pre-reload snapshot.
    setMergeBase(cloneTagsFile(loaded.file));
    readOnlyTags = loaded.fromFuture || loaded.noMigrationPath || loaded.corrupt;
    // Only re-save when the merge diverged from disk; an identical-bytes echo
    // would bump mtime and re-arm the 30 s reconcile loop.
    if (!sameJson(file, loaded.file)) scheduleSave();
    return diskDiffersFromMemory;
  },

  reset(): void {
    activeVaultRoot = null;
    isHydrated = false;
    file = emptyTagsFile();
    setMergeBase(emptyTagsFile());
    readOnlyTags = false;
  },

  /** Forces a synchronous write of any pending debounced save. */
  async flush(): Promise<void> {
    await flushAllMisc();
  },

  // ── Read-side ──────────────────────────────────────────────────────────────

  /** A file's tags: a note's from its frontmatter, anything else's from tags.json. */
  tagsForFile(path: string): string[] {
    if (isNotePath(path)) return noteTags(path);
    return pureTagsForFile(file, path);
  },

  /**
   * Files carrying `tagName`: notes (by frontmatter) and tagged media files.
   * Exact spelling (the delete and its undo act on this list); `anyCase`
   * also lists `Project` for `project`, as the Tags Browser counts them.
   */
  filesForTag(tagName: string, anyCase = false): string[] {
    const has = (tags: readonly string[]): boolean =>
      anyCase ? tags.some((t) => sameTag(t, tagName)) : tags.includes(tagName);
    // Path order: the index holds notes in the order their reads finished.
    const notes = vaultIndexStore.allMetadata()
      .filter((m) => has(noteTags(m.path)))
      .map((m) => m.path)
      .sort((a, b) => normalizeVaultRelative(a).localeCompare(normalizeVaultRelative(b)));
    const media = anyCase
      ? Object.entries(file.fileTags).filter(([, tags]) => has(tags)).map(([p]) => p)
      : pureFilesForTag(file, tagName);
    return [...notes, ...media.filter((p) => !isNotePath(p))];
  },

  allTagNames(): string[] {
    return pureAllTagNames(file);
  },

  getDefinition(tagName: string) {
    return pureGetTagDefinition(file, tagName);
  },

  /**
   * Returns every tile on every loaded board that carries the given tag name
   * in any spelling (`Project` for `project`), read from wherever the
   * tile's tags live. The Tags Browser counts every spelling as one tag, so
   * the lists it opens do too.
   */
  getTilesWithTag(tagName: string): TaggedTile[] {
    const results: TaggedTile[] = [];
    for (const boardId of Object.keys(boardCacheStore.cache)) {
      for (const tile of Object.values(boardCacheStore.getFullTilesForBoard(boardId))) {
        if (tile.tags.some((t) => sameTag(t, tagName))) {
          results.push({ id: tile.id, boardId, type: tile.type, title: tile.title, tags: tile.tags, path: tagFileOfTile(tile) });
        }
      }
    }
    return results;
  },

  /**
   * Returns vault files carrying the given tag name, minus any path already
   * represented by a placed tile (those are shown in the tiles section of the
   * Tag popup).
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
    for (const path of this.filesForTag(tagName, true)) {
      if (normExcluded.has(normalizeVaultRelative(path))) continue;
      const title = isNotePath(path) ? noteTitle(path) : (path.split('/').pop() ?? path);
      out.push({ path, title, tags: this.tagsForFile(path) });
    }
    return out;
  },

  /**
   * Every tag's file and tile counts in one walk of the vault index and the
   * boards — the per-tag `filesForTag` / `getTilesWithTag` each walk them all.
   */
  tagUsageCounts(): Map<string, TagCounts> {
    const files: Array<{ tags: readonly string[] }> = vaultIndexStore.allMetadata().map((m) => ({ tags: noteTags(m.path) }));
    for (const [path, tags] of Object.entries(file.fileTags)) {
      if (!isNotePath(path)) files.push({ tags });
    }
    const tiles: Tile[] = [];
    for (const boardId of Object.keys(boardCacheStore.cache)) {
      tiles.push(...Object.values(boardCacheStore.getFullTilesForBoard(boardId)));
    }
    return countTagUsage(files, tiles);
  },

  getTagUsageCount(tagName: string): number {
    const tiles = this.getTilesWithTag(tagName);
    // Dedup the files section against placed tiles' files so a tile and its
    // file aren't double-counted.
    const placedPaths = new SvelteSet<VaultPath>();
    for (const { path } of tiles) if (path) placedPaths.add(vaultPath(path));
    return tiles.length + this.getFilesWithTag(tagName, placedPaths).length;
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
   * Rejects tag names that wouldn't survive a YAML
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
   * Drains the debounced `.filo/tags.json` write immediately and awaits it.
   * The rename cascade calls this after its in-memory `renameFile` /
   * `renameFolder` so the tag rename lands in the same critical section as
   * the board flush. Otherwise a crash inside the 300ms debounce would leave
   * `tags.json` keyed by the OLD path while every `.board.json` points at the
   * new one — tag loss the (board-only) rename-cascade sentinel can't recover.
   *
   * No-op (resolves `{ ok: true }`) when no save is pending.
   */
  async flushPendingSave(): Promise<{ ok: boolean }> {
    return flushMiscWrite(TAGS_WRITE_KEY);
  },

  // ── Tile-aware mutations ──────────────────────────────────────────────────

  /** The tile with `tileId` on any loaded board, with its tags read from where they live. */
  findTile(tileId: string): Tile | undefined {
    return findTile(tileId);
  },

  /**
   * Adds a tag to a tile by name, where the tile's tags live: its note's
   * frontmatter, its media file's tags.json entry, or (board-only tile) the
   * tile itself. Idempotent — adding a tag a tile already carries is a no-op.
   */
  addTagToTile(tileId: string, tagName: string): void {
    // Validate and canonicalise upfront so a no-op never reaches history.
    const tile = findTile(tileId);
    if (!tile || !tagName) return;
    const trimmed = canonicaliseTagName(file, tagName);
    if (!trimmed || tile.tags.includes(trimmed)) return;
    // Push an undoable command so Ctrl+Z reverses the tag add. Global tag
    // rename remains excluded from history (see `renameTag` — multi-file
    // disk-write batch is too coarse-grained for a single command).
    historyStore.execute(new AddTileTagCommand(tileId, trimmed));
  },

  /** Removes a tag from a tile, where the tile's tags live. */
  removeTagFromTile(tileId: string, tagName: string): void {
    const tile = findTile(tileId);
    if (!tile || !tile.tags.includes(tagName)) return;
    historyStore.execute(new RemoveTileTagCommand(tileId, tagName));
  },

  /**
   * Internal impl of `addTagToTile` — no history push. Called by
   * `AddTileTagCommand.execute()` and `RemoveTileTagCommand.undo()`.
   */
  _applyAddTagToTile(tileId: string, tagName: string): void {
    const tile = findTile(tileId);
    if (!tile || tile.tags.includes(tagName)) return;
    const path = tagFileOfTile(tile);
    if (path) {
      this._applyAddTagToPath(path, tagName);
      return;
    }
    this.ensureTag(tagName);
    boardCacheStore.persistUpdateTile(tileId, { tags: [...tile.tags, tagName] }, tile.boardId);
  },

  /** Internal impl of `removeTagFromTile` — no history push. */
  _applyRemoveTagFromTile(tileId: string, tagName: string): void {
    const tile = findTile(tileId);
    if (!tile || !tile.tags.includes(tagName)) return;
    const path = tagFileOfTile(tile);
    if (path) {
      this._applyRemoveTagFromPath(path, tagName);
      return;
    }
    boardCacheStore.persistUpdateTile(tileId, { tags: tile.tags.filter((t) => t !== tagName) }, tile.boardId);
  },

  /**
   * File-path counterpart of `addTagToTile`, for editing surfaces that aren't
   * a tile (Document board, sidebar). Idempotent.
   */
  addTagToPath(path: string, tagName: string): void {
    if (!path) return;
    const trimmed = canonicaliseTagName(file, tagName ?? '');
    if (!trimmed) return;
    if (this.tagsForFile(path).includes(trimmed)) return;
    // Push an undoable command so Ctrl+Z reverses the add (mirrors `addTagToTile`).
    historyStore.execute(new AddPathTagCommand(path, trimmed));
  },

  /** File-path counterpart of `removeTagFromTile`. Idempotent. */
  removeTagFromPath(path: string, tagName: string): void {
    if (!path || !tagName) return;
    if (!this.tagsForFile(path).includes(tagName)) return;
    historyStore.execute(new RemovePathTagCommand(path, tagName));
  },

  /**
   * Internal impl of `addTagToPath` — no history push. A note gets the tag
   * in its frontmatter; any other file gets it in tags.json.
   */
  _applyAddTagToPath(path: string, tagName: string): void {
    if (!path) return;
    const trimmed = canonicaliseTagName(file, tagName ?? '');
    if (!trimmed) return;
    if (this.tagsForFile(path).includes(trimmed)) return;
    this.ensureTag(trimmed);
    if (isNotePath(path)) void writeTagChangeToMarkdownPath(path, trimmed, 'add');
    else this.addTagToFile(path, trimmed);
  },

  /** Internal impl of `removeTagFromPath` — no history push. */
  _applyRemoveTagFromPath(path: string, tagName: string): void {
    if (!path || !tagName) return;
    if (!this.tagsForFile(path).includes(tagName)) return;
    if (isNotePath(path)) void writeTagChangeToMarkdownPath(path, tagName, 'remove');
    else this.removeTagFromFile(path, tagName);
  },

  /**
   * Renames a tag everywhere: `.md` frontmatter, `.filo/tags.json`
   * (definition + media fileTags), board-only tiles on every board, and
   * saved-view + lastView filter chips. Used by the Tag Browser's rename button.
   *
   * Awaits `boardCacheStore.ensureAllLoaded()` so the cascade reaches
   * every `.board.json` in the vault, not just those currently hydrated.
   * Under normal operation the cache is fully hydrated at vault open, so
   * the await is effectively free.
   *
   * Atomicity: `.md` frontmatter rewrites run *first*. The
   * registry, board-only-tile, and board-settings rewrites only
   * commit if every `.md` write succeeded. On partial failure the
   * in-memory state stays at the old name and the toast offers a retry
   * scoped to the unwritten files — re-running with the same arguments
   * naturally targets only those, since the metadata of the succeeded
   * files no longer mentions `oldName`.
   */
  async renameTagEverywhere(oldName: string, newName: string): Promise<TagSweepOutcome> {
    const trimmed = newName.trim();
    if (!oldName || !trimmed || oldName === trimmed) return notCommitted();

    // Capture identity up-front; threaded into the sweep (writes anchored to
    // the outgoing root → main-side rejected) + the retry toast closure, and
    // re-checked before every in-memory commit so a swap on any await below
    // can't rename the swapped-in vault.
    const identity = captureVaultIdentity();
    await boardCacheStore.ensureAllLoaded();

    // Drain pending markdown / frontmatter debouncers BEFORE the sweep reads
    // metadata. Otherwise an unflushed edit fires after the sweep and
    // re-asserts the OLD tag name on disk.
    const { failed: failedPaths } = await noteStore.flushAll();
    if (failedPaths.length > 0) {
      uiStore.pushToast({
        text: `Tag rename aborted — could not flush pending edits to ${failedPaths.length} file${failedPaths.length === 1 ? '' : 's'}. Resolve the per-file errors above and try again.`,
        type: 'error',
        duration: 0,
      });
      return notCommitted();
    }

    const result = await runTagRewriteSweep(oldName, trimmed, identity.path);
    if (result.failed.length > 0) {
      const failedSet = new SvelteSet(result.failed);
      pushTagRewriteFailureToast({
        verb: 'Tag rename',
        failedCount: result.failed.length,
        attempted: result.attempted,
        retry: () => rewriteAndCommitRetry(this, oldName, trimmed, failedSet, identity),
      });
      return notCommitted();
    }

    // A swap during the sweep above must not mutate the new vault's
    // boardStore/registry with this vault's rename.
    if (!isStillSameVault(identity)) return notCommitted();
    commitTagRenameInMemory(this, oldName, trimmed);
    // Flush the registry write before the board flush so a crash can't strand
    // the renamed tag on disk without its tags.json definition.
    await this.flushPendingSave();
    // Flush the cascaded board writes so a `.board.json` failure is reported
    // through the same toast surface as the .md failures above.
    const committed = { committed: true, writtenPaths: result.succeeded };
    if (!isStillSameVault(identity)) return committed; // swap during flushPendingSave
    await flushTagRewriteBoardWrites('Tag rename');
    return committed;
  },

  /**
   * Removes a tag everywhere: `.md` frontmatter + definition + media file
   * assignments + board-only tiles + saved-view + lastView filter chips.
   *
   * See {@link renameTagEverywhere} for the atomicity rationale — same
   * shape applies here.
   */
  async removeTagEverywhere(tagName: string): Promise<TagSweepOutcome> {
    if (!tagName) return notCommitted();

    // See renameTagEverywhere: capture identity so a vault swap mid-sweep/commit
    // can't apply this vault's tag removal to the swapped-in one.
    const identity = captureVaultIdentity();
    await boardCacheStore.ensureAllLoaded();

    // See renameTagEverywhere: flush the debouncers before the sweep reads metadata.
    const { failed: failedPaths } = await noteStore.flushAll();
    if (failedPaths.length > 0) {
      uiStore.pushToast({
        text: `Tag removal aborted — could not flush pending edits to ${failedPaths.length} file${failedPaths.length === 1 ? '' : 's'}. Resolve the per-file errors above and try again.`,
        type: 'error',
        duration: 0,
      });
      return notCommitted();
    }

    const result = await runTagRewriteSweep(tagName, null, identity.path);
    if (result.failed.length > 0) {
      const failedSet = new SvelteSet(result.failed);
      pushTagRewriteFailureToast({
        verb: 'Tag removal',
        failedCount: result.failed.length,
        attempted: result.attempted,
        retry: () => rewriteAndCommitRetry(this, tagName, null, failedSet, identity),
      });
      return notCommitted();
    }

    // A swap during the sweep must not mutate the new vault's state.
    if (!isStillSameVault(identity)) return notCommitted();
    commitTagRemovalInMemory(this, tagName);
    // See renameTagEverywhere: flush the registry, then the board writes.
    await this.flushPendingSave();
    const committed = { committed: true, writtenPaths: result.succeeded };
    if (!isStillSameVault(identity)) return committed; // swap during flushPendingSave
    await flushTagRewriteBoardWrites('Tag removal');
    return committed;
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

// Tile derivation reads media tags through `noteMeta` (no import cycle here).
registerMediaTagsReader((path) => pureTagsForFile(file, path));

// Vault-swap reset: drop the tag registry + file-tag assignments so the new
// vault's `.filo/tags.json` doesn't merge with stale entries from the prior vault.
onVaultSwap('pre-swap', 'fileTags', () => {
  fileTagsStore.reset();
});
