/**
 * Tag cascade helpers for fileTags.svelte.ts. They only mutate
 * `boardCacheStore` state (never the TagsFile state) and only run during
 * cascade operations, so they live here to keep fileTags.svelte.ts focused.
 *
 * Boards hold tags only on board-only tiles (link / iframe / timer); a note's
 * tags are in its frontmatter (rewritten by the `.md` sweep) and a media
 * file's in tags.json (rewritten by the registry rename/delete).
 *
 * Helpers that call back into the store take it through the minimal
 * `TagCascadeStore` interface to avoid a circular import.
 */

import { SvelteSet } from 'svelte/reactivity';
import { boardCacheStore } from './boardCache.svelte';
import { bumpBoardViewRevision } from './boardViewRevision.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { isInlineTileType } from '../lib/boards/tileDefBuilder';
import { uiStore } from './ui.svelte';
import { tagSweepLabel, withTagSweepProgress } from './tagSweepProgress.svelte';
import {
  rewriteTagInAllMarkdown,
  type MarkdownRewriteResult,
} from '../lib/vault/tagRewriteSweep';
import { captureVaultIdentity, isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';

/**
 * Minimal structural type for the methods the cascade reaches into on the
 * tag store. Keeps this file decoupled from `typeof fileTagsStore`, which
 * would re-introduce the circular import we're trying to undo.
 */
export interface TagCascadeStore {
  renameTag(oldName: string, newName: string): string[];
  deleteTag(tagName: string): string[];
  ensureTag(tagName: string, color?: string): void;
  // The retry path drains the registry write after the commit, mirroring
  // renameTagEverywhere / removeTagEverywhere.
  flushPendingSave(): Promise<{ ok: boolean }>;
}

/** Every board-only tile (link / iframe / timer) on every loaded board. */
export function* iterateBoardOnlyTiles(): Generator<{ boardId: string; id: string; tags: string[] }> {
  for (const [boardId, data] of Object.entries(boardCacheStore.cache)) {
    for (const def of Object.values(data.tileDefs ?? {})) {
      if (isInlineTileType(def.type)) yield { boardId, id: def.id, tags: (def as { tags?: string[] }).tags ?? [] };
    }
    const inline = (data.board as { inlineTiles?: Record<string, { tags?: string[] }> }).inlineTiles ?? {};
    for (const [id, t] of Object.entries(inline)) yield { boardId, id, tags: t.tags ?? [] };
  }
}

/** Rewrites the tags of every board-only tile that `map` changes. */
function rewriteBoardOnlyTileTags(map: (tags: string[]) => string[] | null): void {
  const updates: Array<{ boardId: string; id: string; tags: string[] }> = [];
  for (const t of iterateBoardOnlyTiles()) {
    const next = map(t.tags);
    if (next) updates.push({ boardId: t.boardId, id: t.id, tags: next });
  }
  for (const u of updates) boardCacheStore.persistUpdateTile(u.id, { tags: u.tags }, u.boardId);
}

/**
 * Shape of a Kanban / Task List saved view + lastView slice that exposes a
 * `filterTags: string[]` array. Both board types and both slots use the same
 * field — collapsing them through this minimal interface lets the cascade
 * walk every kind in one loop without leaking schema details.
 */
interface FilterTagsCarrier {
  filterTags?: string[];
}

/**
 * Cascades a tag rename / delete into every loaded board's
 * `settings.savedViews[*].filterTags` and `settings.lastView.filterTags`.
 * Pass `null` for `newName` to delete; otherwise the old name is replaced.
 *
 * Mutates settings in place and schedules a debounced write per board so the
 * change reaches `.board.json`. A mounted board's runtime filter state
 * (`KanbanFiltersAndSort.activeFilterTags`, the Task List equivalent) is
 * re-hydrated from the updated `lastView` through the board's view revision.
 */
export function cascadeTagToBoardSettings(oldName: string, newName: string | null): void {
  for (const [boardId, data] of Object.entries(boardCacheStore.cache)) {
    const settings = (data.board.settings ?? {}) as {
      savedViews?: FilterTagsCarrier[];
      lastView?: FilterTagsCarrier;
    };
    let changed = false;

    const rewriteCarrier = (carrier: FilterTagsCarrier): boolean => {
      const ft = carrier.filterTags;
      if (!Array.isArray(ft) || !ft.includes(oldName)) return false;
      if (newName === null) {
        carrier.filterTags = ft.filter((t) => t !== oldName);
      } else {
        carrier.filterTags = Array.from(
          new SvelteSet(ft.map((t) => (t === oldName ? newName : t))),
        );
      }
      return true;
    };

    if (Array.isArray(settings.savedViews)) {
      for (const view of settings.savedViews) {
        if (rewriteCarrier(view)) changed = true;
      }
    }
    if (settings.lastView && typeof settings.lastView === 'object') {
      if (rewriteCarrier(settings.lastView)) changed = true;
    }

    if (changed) {
      boardCacheStore.markDirty(boardId);
      // A mounted board takes the rewritten `lastView` into its filters; left
      // alone, it would write the old tag back on its next save.
      bumpBoardViewRevision(boardId);
    }
  }
}

/**
 * Convenience wrapper that pipes the store's metadata index + applyChanges
 * callback into the pure `rewriteTagInAllMarkdown` sweep.
 *
 * `vaultRoot` is an explicit captured root, not a live `vaultStore.path` read.
 * The sweep is long-running; if the vault swaps mid-sweep the writes still
 * target the captured (outgoing) root, which main-side `assertActiveVault`
 * rejects — fail-closed instead of applying the tag op to the new vault's
 * same-named files.
 *
 * The sweep finds its notes through the note index, so it waits for a build
 * in progress (the one a vault open starts): sampled mid-build, the index
 * would hold only some of the notes that carry the tag.
 *
 * It runs under a progress toast (`withTagSweepProgress`), which also keeps
 * the Tags Browser's Rename and Delete disabled until it ends.
 */
export async function runTagRewriteSweep(
  oldName: string,
  newName: string | null,
  vaultRoot: string,
  pathFilter?: ReadonlySet<string>,
): Promise<MarkdownRewriteResult> {
  const captured = captureVaultIdentity();
  return withTagSweepProgress(tagSweepLabel(oldName, newName), async (onProgress) => {
    await vaultIndexStore.whenBuildComplete();
    // Another vault opened meanwhile: its index isn't this vault's notes.
    if (!isStillSameVault(captured)) return { attempted: 0, succeeded: [], failed: [] };
    return rewriteTagInAllMarkdown({
      vaultRoot,
      metadata: vaultIndexStore.allMetadata(),
      oldName,
      newName,
      applyChanges: (paths) => vaultIndexStore.applyChanges(paths),
      pathFilter,
      onProgress,
    });
  });
}

/**
 * Surfaces a single aggregate toast when a tag-rewrite sweep failed for
 * some `.md` files. Includes a "Retry failed files" action so the user
 * can re-attempt without re-walking the entire metadata index — the
 * caller provides the closure that targets only the unwritten paths.
 */
export function pushTagRewriteFailureToast(opts: {
  verb: string;
  failedCount: number;
  attempted: number;
  retry: () => void | Promise<void>;
}): void {
  uiStore.pushToast({
    text: `${opts.verb} failed for ${opts.failedCount} of ${opts.attempted} files. Your tag registry and boards are unchanged — retry to apply the remaining files.`,
    type: 'error',
    duration: 0,
    actions: [
      { label: 'Retry failed files', handler: opts.retry },
    ],
  });
}

/**
 * Flushes pending `.board.json` writes scheduled by the
 * in-memory cascade (commitTagRenameInMemory / commitTagRemovalInMemory)
 * and surfaces an error toast if any board write failed.
 *
 * The `.md` sweep already runs before the in-memory commit, so by this
 * point the markdown side has succeeded. A board write failure here means
 * the registry + board-only tiles got updated in memory but one or more
 * `.board.json` files couldn't be written. We don't roll back the in-memory
 * state — the failed paths are already in `failedVaultPaths` via
 * `endWrite(..., false)` and the recovery sentinel reflects that.
 */
export async function flushTagRewriteBoardWrites(verb: string): Promise<void> {
  const result = await boardCacheStore.flushAllDirty();
  if (result.failed.length === 0) return;
  const previewLimit = 3;
  const preview = result.failed.slice(0, previewLimit).join(', ');
  const extras = result.failed.length > previewLimit
    ? ` (+${result.failed.length - previewLimit} more)`
    : '';
  uiStore.pushToast({
    text: `${verb} reached every note, but ${result.failed.length} board${result.failed.length === 1 ? '' : 's'} couldn't be saved: ${preview}${extras}. Filo keeps the change and tries those boards again on the next save.`,
    type: 'error',
    duration: 0,
  });
}

/**
 * Commits the in-memory tag-rename cascade once the corresponding `.md`
 * file rewrites have succeeded: the registry (definition + media fileTags),
 * board-only tiles, and saved-view / lastView filter chips. The split exists
 * so the retry path can fire the same commit without duplicating the loops.
 */
export function commitTagRenameInMemory(
  store: TagCascadeStore,
  oldName: string,
  newName: string,
): void {
  store.renameTag(oldName, newName);
  store.ensureTag(newName);
  rewriteBoardOnlyTileTags((tags) =>
    tags.includes(oldName) ? Array.from(new SvelteSet(tags.map((t) => (t === oldName ? newName : t)))) : null,
  );
  cascadeTagToBoardSettings(oldName, newName);
}

/**
 * Commits the in-memory tag-removal cascade once the corresponding `.md`
 * file rewrites have succeeded. Mirror of {@link commitTagRenameInMemory}
 * for the delete path.
 */
export function commitTagRemovalInMemory(
  store: TagCascadeStore,
  tagName: string,
): void {
  store.deleteTag(tagName);
  rewriteBoardOnlyTileTags((tags) => (tags.includes(tagName) ? tags.filter((t) => t !== tagName) : null));
  cascadeTagToBoardSettings(tagName, null);
}

/**
 * Retry handler installed on the failure toast. Re-runs the `.md`
 * rewrite but scoped to the previously-failed paths only — the
 * `vaultIndexStore.allMetadata()` walk in `rewriteTagInAllMarkdown` would
 * otherwise re-check every file again (slow on large vaults), and would
 * also skip files whose tag was already rewritten on the first attempt.
 *
 * Commits the in-memory cascade only when the retry sweep is clean. A
 * still-partial retry surfaces another toast so the user can keep
 * retrying or give up; each iteration narrows the failed-paths set.
 */
export async function rewriteAndCommitRetry(
  store: TagCascadeStore,
  oldName: string,
  newName: string | null,
  failedPaths: ReadonlySet<string>,
  identity: VaultIdentity,
): Promise<void> {
  // The failure toast (duration: 0) survives a vault swap. Without this bail a
  // retry after a swap would apply the old vault's tag op to the new vault's
  // same-named files (main accepts them — they target the active vault).
  if (!isStillSameVault(identity)) return;
  const verb = newName === null ? 'Tag removal' : 'Tag rename';
  const result = await runTagRewriteSweep(oldName, newName, identity.path, failedPaths);
  if (result.failed.length > 0) {
    const stillFailed = new SvelteSet(result.failed);
    pushTagRewriteFailureToast({
      verb,
      failedCount: result.failed.length,
      attempted: result.attempted,
      retry: () => rewriteAndCommitRetry(store, oldName, newName, stillFailed, identity),
    });
    return;
  }
  // Guard the in-memory commit: a swap DURING the sweep above must not mutate the
  // NEW vault's boardStore / registry with the outgoing vault's tag op.
  if (!isStillSameVault(identity)) return;
  if (newName === null) {
    commitTagRemovalInMemory(store, oldName);
  } else {
    commitTagRenameInMemory(store, oldName, newName);
  }
  // Drain the registry write before the board flush (same crash-window guard
  // as renameTagEverywhere / removeTagEverywhere).
  await store.flushPendingSave();
  // Re-check before the board flush (flushPendingSave above can yield across a swap).
  if (!isStillSameVault(identity)) return;
  await flushTagRewriteBoardWrites(verb);
}
