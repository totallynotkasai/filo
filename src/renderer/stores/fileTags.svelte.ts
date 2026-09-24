/**
 * fileTagsStore — reactive Svelte 5 wrapper around `.filo/tags.json`.
 *
 * The single canonical tag store:
 *   - tag definitions (name → colour) — the only place colours live.
 *   - file-tag assignments (vault-relative path → tag-name array) — covers
 *     `.md`, attachments, and `.board.json` files alike.
 *   - tile-aware action helpers — addTagToTile / removeTagFromTile /
 *     renameTagEverywhere / removeTagEverywhere — coordinate tile.tags arrays
 *     on board files with frontmatter mirrors for text-backed tiles.
 *
 * Tag identity is the tag NAME (not an ID). `tile.tags: string[]` carries
 * names directly.
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
import { scheduleMiscWrite, flushAllMisc, flushMiscWrite, markPathFailed } from '../lib/boards/boardSaver';
import { flushAllMarkdownWriters, runSerializedMarkdownWrite } from '../lib/vault/markdownFileWriter';
import { refreshBaselineAfterWrite, getBaseline, hasBaselineDrifted } from '../lib/vault/fileBaselineRegistry';
import { writeMarkdownAndReconcile } from '../lib/vault/syncOpenEditorsAfterDiskMutation';
import { resolveTextTileVaultPath } from '../lib/boards/textTilePath';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { flushAllPendingFrontmatterWrites } from '../lib/boards/frontmatterWriteScheduler';
import { invokeOk } from '../lib/utils/invokeOk';
import { assertIpcOk } from '../lib/utils/ipcEnvelope';
import { reportError } from '../lib/utils/errorBus';
import { uiStore } from './ui.svelte';
import { onVaultSwap, vaultSwapResettable } from '../core/vaultLifecycle';
import { cloneTagsFile, sameJson, mergeTagsThreeWay } from '../lib/vault/tagsFileMerge';

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

/**
 * True when the bytes the single-tag fast path just READ had already drifted
 * from the pre-write baseline (an undetected external edit). The stat comes
 * from the same `vault:read-file-text`, so no extra IPC. Gates the post-write
 * `refreshBaselineAfterWrite`: stamping on drift would launder the external
 * edit into the baseline and the open editor's next save would silently revert
 * it. Conservative: no prior baseline → false; read withheld its stat (a write
 * raced the read) → treat as drifted.
 */
function baselineDriftedAtRead(
  relPath: string,
  readMtimeMs: number | undefined,
  readSize: number | undefined,
): boolean {
  const baseline = getBaseline(relPath);
  if (baseline === undefined) return false;
  if (readMtimeMs === undefined || readSize === undefined) return true;
  return hasBaselineDrifted(baseline, { mtimeMs: readMtimeMs, size: readSize });
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
  // Capture identity before the live-path read so the post-await guards below
  // bail on a vault swap instead of applying this vault's tag-write bookkeeping
  // (markPathFailed / baseline / index) to the new one.
  const identity = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  // Canonical resolver (filePath → docState → folder cascade); a `${title}.md`
  // root fallback would write a subfolder tile's tag to an unrelated root note.
  const relPath = resolveTextTileVaultPath(tile, (tile as { boardId?: string }).boardId);
  if (!vaultRoot || !relPath) return;

  try {
    let wrote = false;
    // Run the whole read-modify-write serialised behind any in-flight gateway
    // write to this path. The read happens INSIDE the chain so it observes a
    // prior body write's bytes, and the IPC write can't interleave with a
    // concurrent editor write.
    await runSerializedMarkdownWrite(relPath, async () => {
      let raw: string | null = null;
      // Capture the read's own stat (no extra IPC) so the post-write baseline
      // stamp below can be suppressed on pre-write drift.
      let readMtimeMs: number | undefined;
      let readSize: number | undefined;
      try {
        const readResult = await invokeOk('vault:read-file-text', vaultRoot, relPath);
        raw = readResult.content;
        readMtimeMs = readResult.mtimeMs;
        readSize = readResult.size;
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
        if (!isStillSameVault(identity)) return; // swap during read/exists
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
      // Pre-write drift? (gates the post-write baseline stamp; see helper)
      const driftedBeforeWrite = baselineDriftedAtRead(relPath, readMtimeMs, readSize);
      const next = operation === 'add'
        ? addTagToMarkdown(raw, tagName)
        : removeTagFromMarkdown(raw, tagName);
      if (next === raw) return;
      // Coupled write+reconcile (frontmatter-only). Writes the existing .md
      // (write-existing so a delete race surfaces as ENOENT, not a resurrection)
      // AND refreshes any open editor's FM cache for the same path so its next
      // body save keeps the tag. Body-preserving.
      await writeMarkdownAndReconcile({
        vaultRoot,
        path: relPath,
        content: next,
        mode: 'frontmatter',
      });
      // Refresh the gateway's pre-write drift baseline to the bytes we just
      // wrote: this path writes the .md directly (not via the gateway), so
      // without it the next editor write sees the mtime+size change as an
      // external edit and shows a false "modified externally" prompt.
      // The baseline is keyed by relPath alone, so bail on a vault swap before
      // stamping. Keep the prior baseline when disk had drifted before this
      // write, so the open editor's next save re-detects + prompts.
      if (driftedBeforeWrite) {
        if (!isStillSameVault(identity)) return;
        refreshBaselineAfterWrite(relPath, undefined, undefined);
      } else {
        try {
          const postStat = await invokeOk('vault:stat', vaultRoot, relPath);
          if (!isStillSameVault(identity)) return;
          refreshBaselineAfterWrite(relPath, postStat.mtimeMs, postStat.size);
        } catch {
          if (!isStillSameVault(identity)) return;
          refreshBaselineAfterWrite(relPath, undefined, undefined);
        }
      }
      wrote = true;
    });
    if (!wrote) return;
    // A swap during the serialized write must not re-index relPath into the
    // new vault or fire its read-only toast against it.
    if (!isStillSameVault(identity)) return;
    await vaultIndexStore.applyChanges([relPath]);
    // The tag landed, but if the editor is held read-only (body can't
    // round-trip) its body edits are NOT being written — tell the user.
    surfaceReadOnlyTagToastIfNeeded(relPath);
  } catch (err) {
    // trackComponentWrite already surfaced the failure via the save-error
    // listener. Local catch keeps fire-and-forget callers from raising
    // unhandled rejections.
    reportError('fileTagsStore', err, `Failed to write tag change to ${relPath}`);
  }
}

/**
 * Fires the read-only tag toast when the file backing the
 * tag write has an open editor that's currently held read-only by the
 * lossy-round-trip sentinel. Deduped by `readOnlyTagToastShown` so a
 * batch of N tag operations against the same file doesn't push N toasts.
 *
 * Idempotent: re-entering after the toast has been shown does nothing
 * until the read-only flag is cleared (via the editor banner's "Take
 * ownership"). The dedupe Set is keyed by docId so the toast can re-fire
 * for the same path if the user reopens it under a fresh docId.
 *
 * Reset on vault swap so a stale docId entry can't
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
  // See writeTagChangeToTileMarkdown: capture identity before the live-path
  // read so the guards below bail on a vault swap.
  const identity = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  if (!vaultRoot || !relPath) return;
  try {
    let wrote = false;
    // See writeTagChangeToTileMarkdown: serialise the read-modify-write on the
    // per-path chain and reconcile the open editor's frontmatter cache afterward.
    await runSerializedMarkdownWrite(relPath, async () => {
      let raw: string | null = null;
      // Capture the read's own stat (see writeTagChangeToTileMarkdown).
      let readMtimeMs: number | undefined;
      let readSize: number | undefined;
      try {
        const readResult = await invokeOk('vault:read-file-text', vaultRoot, relPath);
        raw = readResult.content;
        readMtimeMs = readResult.mtimeMs;
        readSize = readResult.size;
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
        if (!isStillSameVault(identity)) return; // swap during read/exists
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
      // Keep-baseline-on-pre-write-drift (see writeTagChangeToTileMarkdown).
      const driftedBeforeWrite = baselineDriftedAtRead(relPath, readMtimeMs, readSize);
      const next = operation === 'add'
        ? addTagToMarkdown(raw, tagName)
        : removeTagFromMarkdown(raw, tagName);
      if (next === raw) return;
      // Coupled write+reconcile (frontmatter-only); see writeTagChangeToTileMarkdown.
      await writeMarkdownAndReconcile({
        vaultRoot,
        path: relPath,
        content: next,
        mode: 'frontmatter',
      });
      // Refresh the drift baseline to the bytes we just wrote, bailing on a
      // vault swap and keeping the prior baseline on pre-write drift (see
      // writeTagChangeToTileMarkdown).
      if (driftedBeforeWrite) {
        if (!isStillSameVault(identity)) return;
        refreshBaselineAfterWrite(relPath, undefined, undefined);
      } else {
        try {
          const postStat = await invokeOk('vault:stat', vaultRoot, relPath);
          if (!isStillSameVault(identity)) return;
          refreshBaselineAfterWrite(relPath, postStat.mtimeMs, postStat.size);
        } catch {
          if (!isStillSameVault(identity)) return;
          refreshBaselineAfterWrite(relPath, undefined, undefined);
        }
      }
      wrote = true;
    });
    if (!wrote) return;
    // A swap during the serialized write must not re-index relPath into the
    // new vault or fire its read-only toast against it.
    if (!isStillSameVault(identity)) return;
    await vaultIndexStore.applyChanges([relPath]);
    // Same read-only doc toast as writeTagChangeToTileMarkdown.
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
    // file aren't double-counted. Attachment tiles also register their media
    // path in `fileTags`, so include those alongside text tiles.
    const placedPaths = new SvelteSet<VaultPath>();
    for (const def of Object.values(boardStore.allTileDefs)) {
      if (!def.tags?.includes(tagName)) continue;
      const tile = def as Tile;
      // Canonical resolver so dedup keys by the same subfolder-aware path the
      // write path uses (else a subfolder tile double-counts vs its file).
      const textPath = resolveTextTileVaultPath(tile, (tile as { boardId?: string }).boardId);
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
    // disk-write batch is too coarse-grained for a single command).
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
   * Includes the live-tile / tile-def cache fallback for Kanban Card / Task
   * surfaces.
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
      // Same canonical resolver as the .md write, so the tags.json key + sibling
      // propagation can't drift to root while the .md is in a subfolder.
      const path = resolveTextTileVaultPath(tile, (tile as { boardId?: string }).boardId);
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
      // Same canonical resolver as the .md write, so the tags.json key + sibling
      // propagation can't drift to root while the .md is in a subfolder.
      const path = resolveTextTileVaultPath(tile, (tile as { boardId?: string }).boardId);
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
    // Push an undoable command so Ctrl+Z reverses the add (mirrors `addTagToTile`).
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
   * Mirrors `_applyAddTagToTile`.
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
   * Atomicity: `.md` frontmatter rewrites run *first*. The
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

    // Capture identity up-front; threaded into the sweep (writes anchored to
    // the outgoing root → main-side rejected) + the retry toast closure, and
    // re-checked before every in-memory commit so a swap on any await below
    // can't rename the swapped-in vault.
    const identity = captureVaultIdentity();
    await boardCacheStore.ensureAllLoaded();

    // Drain pending markdown / frontmatter debouncers BEFORE the sweep reads
    // metadata. Otherwise an unflushed edit fires after the sweep and
    // re-asserts the OLD tag name on disk.
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

    const result = await runTagRewriteSweep(oldName, trimmed, identity.path);
    if (result.failed.length > 0) {
      const failedSet = new SvelteSet(result.failed);
      pushTagRewriteFailureToast({
        verb: 'Tag rename',
        failedCount: result.failed.length,
        attempted: result.attempted,
        retry: () => rewriteAndCommitRetry(this, oldName, trimmed, failedSet, identity),
      });
      return;
    }

    // A swap during the sweep above must not mutate the new vault's
    // boardStore/registry with this vault's rename.
    if (!isStillSameVault(identity)) return;
    commitTagRenameInMemory(this, oldName, trimmed);
    // Flush the registry write before the board flush so a crash can't strand
    // the renamed tag on disk without its tags.json definition.
    await this.flushPendingSave();
    // Flush the cascaded board writes so a `.board.json` failure is reported
    // through the same toast surface as the .md failures above.
    if (!isStillSameVault(identity)) return; // swap during flushPendingSave
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

    // See renameTagEverywhere: capture identity so a vault swap mid-sweep/commit
    // can't apply this vault's tag removal to the swapped-in one.
    const identity = captureVaultIdentity();
    await boardCacheStore.ensureAllLoaded();

    // See renameTagEverywhere: flush the debouncers before the sweep reads metadata.
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

    const result = await runTagRewriteSweep(tagName, null, identity.path);
    if (result.failed.length > 0) {
      const failedSet = new SvelteSet(result.failed);
      pushTagRewriteFailureToast({
        verb: 'Tag removal',
        failedCount: result.failed.length,
        attempted: result.attempted,
        retry: () => rewriteAndCommitRetry(this, tagName, null, failedSet, identity),
      });
      return;
    }

    // A swap during the sweep must not mutate the new vault's state.
    if (!isStillSameVault(identity)) return;
    commitTagRemovalInMemory(this, tagName);
    // See renameTagEverywhere: flush the registry, then the board writes.
    await this.flushPendingSave();
    if (!isStillSameVault(identity)) return; // swap during flushPendingSave
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

// Vault-swap reset: drop the tag registry + file-tag assignments so the new
// vault's `.filo/tags.json` doesn't merge with stale entries from the prior vault.
onVaultSwap('pre-swap', 'fileTags', () => {
  fileTagsStore.reset();
});
