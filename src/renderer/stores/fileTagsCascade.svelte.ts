/**
 * Tag cascade helpers extracted from fileTags.svelte.ts (Sprint 39 / 39.9).
 *
 * The four "cascade" functions (commitTagRenameInMemory,
 * commitTagRemovalInMemory, iterateInlineTiles, cascadeTagToBoardSettings)
 * and their immediate orchestration (runTagRewriteSweep,
 * pushTagRewriteFailureToast, flushTagRewriteBoardWrites,
 * rewriteAndCommitRetry) all share two traits: they only mutate `boardStore`
 * / `boardCacheStore` state (never the `file` state in fileTags.svelte.ts)
 * and they don't need to be in the fileTagsStore object literal because
 * they only run during cascade operations. Moving them here keeps
 * fileTags.svelte.ts focused on TagsFile wrapping + tile/path mutations.
 *
 * To avoid a circular import with fileTags.svelte.ts the few commit-side
 * helpers that need to call back into the store (renameTag / ensureTag /
 * deleteTag) take it through the `TagCascadeStore` interface — a minimal
 * structural type that the actual fileTagsStore satisfies by construction.
 */

import { SvelteSet } from 'svelte/reactivity';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { vaultStore } from './vault.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { uiStore } from './ui.svelte';
import {
  rewriteTagInAllMarkdown,
  type MarkdownRewriteResult,
} from '../lib/vault/tagRewriteSweep';
import { isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';

/**
 * Minimal structural type for the methods the cascade reaches into on the
 * tag store. Keeps this file decoupled from `typeof fileTagsStore`, which
 * would re-introduce the circular import we're trying to undo.
 */
export interface TagCascadeStore {
  renameTag(oldName: string, newName: string): string[];
  deleteTag(tagName: string): string[];
  ensureTag(tagName: string, color?: string): void;
  // Phase 4.3 (2026-05-30) — the retry path drains the registry write
  // synchronously after the commit, mirroring renameTagEverywhere /
  // removeTagEverywhere. The real fileTagsStore satisfies this by construction.
  flushPendingSave(): Promise<{ ok: boolean }>;
}

/**
 * Iterates every inline tile (link / iframe / timer) across every board in
 * the active project. Mirrors the read pattern used by `getTilesWithTag` so
 * sweeps like `renameTagEverywhere` / `removeTagEverywhere` reach inline
 * tiles on non-active boards — those tiles aren't in `boardStore.tiles`
 * (active-board only) and aren't in `boardStore.allTileDefs` (defs only).
 */
export function* iterateInlineTiles(): Generator<{ id: string; tags?: string[] }> {
  const project = vaultStore.project;
  if (!project) return;
  for (const board of project.boards) {
    const inlineTiles = (board as { inlineTiles?: Record<string, unknown> }).inlineTiles ?? {};
    for (const tile of Object.values(inlineTiles)) {
      const t = tile as { id?: string; tags?: string[] };
      if (typeof t.id !== 'string') continue;
      yield { id: t.id, tags: t.tags };
    }
  }
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
 * change reaches `.board.json`. Active-board runtime filter state
 * (`KanbanFiltersAndSort.activeFilterTags`, the TaskList equivalent) is not
 * touched — a board switch / reopen re-hydrates from the now-updated
 * `lastView`, which is the only path that pins the filter long-term.
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

    if (changed) boardCacheStore.markDirty(boardId);
  }
}

/**
 * Convenience wrapper that pipes the store's metadata index + applyChanges
 * callback into the pure `rewriteTagInAllMarkdown` sweep.
 *
 * Audit-12 H3 — `vaultRoot` is now an EXPLICIT captured root (identity.path),
 * NOT a live `vaultStore.path` read. The sweep is long-running; if the vault
 * swaps mid-sweep the writes still target the CAPTURED (outgoing) root, which
 * main-side `assertActiveVault` rejects — fail-closed, instead of applying the
 * outgoing vault's tag op to the new vault's same-named files. The metadata walk
 * stays live, but every write is anchored to the captured root, so a swapped-in
 * vault's files are never touched.
 */
export function runTagRewriteSweep(
  oldName: string,
  newName: string | null,
  vaultRoot: string,
  pathFilter?: ReadonlySet<string>,
): Promise<MarkdownRewriteResult> {
  return rewriteTagInAllMarkdown({
    vaultRoot,
    metadata: vaultIndexStore.allMetadata(),
    oldName,
    newName,
    applyChanges: (paths) => vaultIndexStore.applyChanges(paths),
    pathFilter,
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
 * Phase 23 M11 — flushes pending `.board.json` writes scheduled by the
 * in-memory cascade (commitTagRenameInMemory / commitTagRemovalInMemory)
 * and surfaces an error toast if any board write failed.
 *
 * The `.md` sweep already runs before the in-memory commit, so by this
 * point the markdown side has succeeded. A board write failure here means
 * the registry + tile-defs got updated in memory but one or more
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
    text: `${verb} reached every .md file but ${result.failed.length} .board.json write${result.failed.length === 1 ? '' : 's'} failed: ${preview}${extras}. The change is in memory and your recovery sentinel will retry on next save.`,
    type: 'error',
    duration: 0,
  });
}

/**
 * Commits the in-memory tag-rename cascade once the corresponding `.md`
 * file rewrites have succeeded. Updates the registry, ensures the new tag
 * has a definition entry, walks active-board tiles, off-board tile defs,
 * inline tiles, and saved-view / lastView filter chips. The split exists
 * so the retry path can fire the same commit without duplicating the
 * loop bodies.
 */
export function commitTagRenameInMemory(
  store: TagCascadeStore,
  oldName: string,
  newName: string,
): void {
  store.renameTag(oldName, newName);
  store.ensureTag(newName);

  for (const tile of Object.values(boardStore.tiles)) {
    if (!tile.tags.includes(oldName)) continue;
    const next = Array.from(new SvelteSet(tile.tags.map((t) => (t === oldName ? newName : t))));
    boardStore.updateTile(tile.id, { tags: next });
  }
  for (const def of Object.values(boardStore.allTileDefs)) {
    if (!def.tags?.includes(oldName)) continue;
    if (boardStore.getTile(def.id)) continue;
    const next = Array.from(new SvelteSet(def.tags.map((t) => (t === oldName ? newName : t))));
    boardStore.persistUpdateTile(def.id, { tags: next });
  }
  for (const inline of iterateInlineTiles()) {
    if (!Array.isArray(inline.tags) || !inline.tags.includes(oldName)) continue;
    if (boardStore.getTile(inline.id)) continue;
    const next = Array.from(new SvelteSet(inline.tags.map((t) => (t === oldName ? newName : t))));
    boardStore.persistUpdateTile(inline.id, { tags: next });
  }

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

  for (const tile of Object.values(boardStore.tiles)) {
    if (!tile.tags.includes(tagName)) continue;
    boardStore.updateTile(tile.id, { tags: tile.tags.filter((t) => t !== tagName) });
  }
  for (const def of Object.values(boardStore.allTileDefs)) {
    if (!def.tags?.includes(tagName)) continue;
    if (boardStore.getTile(def.id)) continue;
    boardStore.persistUpdateTile(def.id, { tags: def.tags.filter((t) => t !== tagName) });
  }
  for (const inline of iterateInlineTiles()) {
    if (!Array.isArray(inline.tags) || !inline.tags.includes(tagName)) continue;
    if (boardStore.getTile(inline.id)) continue;
    boardStore.persistUpdateTile(inline.id, { tags: inline.tags.filter((t) => t !== tagName) });
  }

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
  // Audit-12 H3 — the failure toast (duration: 0) survives a vault swap and this
  // retry closure used to re-read the LIVE vault path at click time. After a swap,
  // a retry walked the NEW vault's files (scoped to the OLD vault's failed rel
  // paths) and main-side assertActiveVault ACCEPTED the writes (they targeted the
  // active vault) — applying vault A's tag op to vault B. Bail if the vault swapped
  // since the failed sweep was captured.
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
  // Phase 4.3 (2026-05-30) — drain the registry write before the board flush,
  // same crash-window guard as the non-retry renameTagEverywhere /
  // removeTagEverywhere paths.
  await store.flushPendingSave();
  // Re-check before the board flush (flushPendingSave above can yield across a swap).
  if (!isStillSameVault(identity)) return;
  await flushTagRewriteBoardWrites(verb);
}
