/**
 * The sidebar delete of a vault file or folder.
 *
 * The item moves into Filo's trash (`.filo/trash`), never unlinked, so the
 * delete is undoable whatever the item's type or size: Ctrl+Z moves it back
 * and restores every tile placement that pointed at it, and Settings → Trash
 * can restore it later. A folder with a locked child fails as a whole, with
 * nothing moved.
 */
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { noteStore } from './notes.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { uiStore } from './ui.svelte';
import { historyStore } from './history.svelte';
import { reindexUnder, toastMovedToTrash } from './trash.svelte';
import { markRecentSelfWrite } from '../lib/boards/writeStateTracking';
import { normalizePath, toPosix, toVaultRelative } from '../lib/utils/path';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import {
  PendingWritesFailedError,
  trashVaultPath,
  withDrainedWrites,
} from '../lib/vault/vaultOperations';
import { pinsUnder, restoreClearedPins } from '../lib/vault/folderPins';
import type { FileTreeNode } from '../../shared/types';
import type { VaultContext } from './vaultStoreTypes';

function findTreeNode(fileTree: FileTreeNode[], vaultRoot: string, relPath: string): FileTreeNode | null {
  const root = normalizePath(vaultRoot).toLowerCase();
  const targetLower = relPath.toLowerCase();
  const stack: FileTreeNode[] = [...fileTree];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const absLower = toPosix(next.path).toLowerCase();
    if (absLower === `${root}/${targetLower}`) return next;
    if (next.children) stack.push(...next.children);
  }
  return null;
}

/** Vault-relative paths of the files at or under `node` (the node itself for a file). */
function filesOf(node: FileTreeNode | null, vaultRoot: string): string[] {
  if (!node) return [];
  const out: string[] = [];
  const stack: FileTreeNode[] = [node];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next.isDirectory) {
      if (next.children) stack.push(...next.children);
      continue;
    }
    const rel = toVaultRelative(next.path, vaultRoot);
    if (rel) out.push(rel);
  }
  return out;
}

/** The `.filo/tags.json` file tags at or under `rel` (path → tags). */
function fileTagsUnder(rel: string): Record<string, string[]> {
  const key = rel.toLowerCase();
  const out: Record<string, string[]> = {};
  for (const [path, tags] of Object.entries(fileTagsStore.file.fileTags)) {
    const lower = path.toLowerCase();
    if (lower === key || lower.startsWith(`${key}/`)) out[path] = [...tags];
  }
  return out;
}

/**
 * Asks, then moves `itemPath` (absolute) into Filo's trash and removes what
 * pointed at it: tile placements on every board (undoable as one command),
 * boards inside a deleted folder, Document boards showing a deleted note, and
 * the item's file tags. Returns whether the item was moved.
 */
export async function performDelete(ctx: VaultContext, itemPath: string): Promise<boolean> {
  // The confirm runs OUTSIDE `withDrainedWrites` so a long-thinking user
  // doesn't hold the editor's debounce, and a cancelled prompt never
  // surfaces a spurious "pending writes failed" toast.
  const itemName = itemPath.split(/[\\/]/).pop() ?? itemPath;
  const node = findTreeNode(ctx.getFileTree(), ctx.getVaultPath(), toVaultRelative(itemPath, ctx.getVaultPath()) ?? '');
  const isFolder = node?.isDirectory ?? false;
  const confirmed = await uiStore.confirmAsync({
    title: isFolder ? 'Delete folder?' : 'Delete file?',
    body: isFolder
      ? `"${itemName}" and everything inside it will be moved to Filo's trash. Tiles that show them are removed from every board. Undo, or restore it from Settings → Trash.`
      : `"${itemName}" will be moved to Filo's trash. Tiles that show it are removed from every board. Undo, or restore it from Settings → Trash.`,
    confirmLabel: isFolder ? 'Delete folder' : 'Delete file',
    danger: true,
  });
  if (!confirmed) return false;

  // The post-move cascade mutates the cache / tags / notes keyed by the
  // OUTGOING vault's path; a swap during an await would run it against the
  // NEW vault. The disk move is main-side gated; the in-memory cascade is not.
  const deleteIdentity = captureVaultIdentity();

  try {
    return await withDrainedWrites(async (drain) => {
      const vaultRoot = ctx.getVaultPath();
      const rel = toVaultRelative(itemPath, vaultRoot);
      if (!rel) return false;
      // Clear the active-root pointer and per-board default-folder pins
      // BEFORE the move, so an autosave resolving a path through them can't
      // recreate the folder via `fs.mkdir(..., recursive)`. They come back if
      // the move fails, and on undo.
      const general = ctx.getProject()?.settings.general;
      const clearedPins = pinsUnder(general, rel);
      const restorePins = (): void => restoreClearedPins(clearedPins, general, () => ctx.markMetaDirty());
      ctx.clearActiveRootFolderIfMatches(itemPath);
      boardStore.clearBoardDefaultFolderIfMatches(itemPath);

      // Our own move must not come back through the watcher as an external
      // delete (`handleExternalRename`).
      markRecentSelfWrite(rel);
      for (const path of filesOf(node, vaultRoot)) markRecentSelfWrite(path);

      const result = await trashVaultPath(vaultRoot, rel, drain);
      if (!result.success) {
        if (isStillSameVault(deleteIdentity)) restorePins();
        uiStore.pushToast({
          text: `Couldn't move "${itemName}" to Filo's trash${result.error ? `: ${result.error}` : ''}. Nothing was deleted; a file inside may be open in another program.`,
          type: 'error',
          duration: 6000,
        });
        return false;
      }
      const trashed = { rel, trashId: result.trashId };

      // Hydrate every board before the cascade walks the cache, so a board
      // that failed to hydrate at vault open doesn't keep stale references.
      await boardCacheStore.ensureAllLoaded();
      // Vault swapped during the awaits: the move landed in the correct (old)
      // vault, so report success and skip the cross-vault in-memory cascade.
      if (!isStillSameVault(deleteIdentity)) return true;
      // Boards whose `.board.json` went with the item: drop their cache,
      // project entry, viewport, open tabs and undo history now, rather than
      // leaving a phantom tab until the watcher reconcile.
      const relLower = toPosix(rel).toLowerCase();
      const relPrefix = relLower.endsWith('/') ? relLower : `${relLower}/`;
      // Board undo lives on the active board's stack. With no board open, a
      // Document tab active (its stack is the note's text history, keyed by a
      // tab id no board file carries), or the active board's own file going
      // with the item, no board stack the user can reach holds the delete:
      // the toast offers the undo instead.
      const activeId = historyStore.activeBoardId;
      const activePath = activeId ? toPosix(boardStore.paths[activeId] ?? '').toLowerCase() : '';
      const noBoardUndo = !activeId
        || !boardCacheStore.cache[activeId]
        || activePath === relLower
        || activePath.startsWith(relPrefix);
      const cleanupPromises: Array<Promise<unknown>> = [];
      for (const [boardId, bp] of Object.entries(boardStore.paths)) {
        if (!bp) continue;
        const bpLower = toPosix(bp).toLowerCase();
        if (bpLower === relLower || bpLower.startsWith(relPrefix)) {
          cleanupPromises.push(boardStore.cleanupMissingBoardAsync(boardId));
        }
      }
      // Flush debounced placements BEFORE the cascade walks the cache, so a
      // card dropped within the 300 ms debounce can't persist its placement
      // after the cascade removed it.
      await boardCacheStore.flushAllDirty();
      if (!isStillSameVault(deleteIdentity)) return true;

      const fileTags = fileTagsUnder(rel);
      const { command } = boardStore.cascadeDeleteByVaultPath(rel, {
        vaultRoot, trashed, fileTags, clearedPins, offStack: noBoardUndo,
      });
      // Drop tag associations for the item (exact match for a file, prefix
      // for a folder; both are safe either way). Undo puts them back.
      fileTagsStore.dropFile(rel);
      fileTagsStore.dropFolder(rel);
      // Drain the tag drop in the same critical section as the board flush
      // below. A failed flush leaves an orphan entry that
      // `pruneOrphanFileTags` removes on next open; we still say so.
      let tagsDropFlushOk = true;
      try {
        const tagsDropFlush = await fileTagsStore.flushPendingSave();
        tagsDropFlushOk = tagsDropFlush.ok;
      } catch {
        tagsDropFlushOk = false;
      }
      if (!isStillSameVault(deleteIdentity)) return true;
      // Document boards whose note went with the item, even when the board
      // file lives elsewhere: clear the dangling `filePath` on disk BEFORE the
      // cache entry goes, so reopening shows the "no backing file" state.
      for (const [boardId, cached] of Object.entries(boardCacheStore.cache)) {
        const b = cached.board;
        if (b.type !== 'document') continue;
        if (!b.filePath) continue;
        const docPathLower = toPosix(b.filePath).toLowerCase();
        if (docPathLower === relLower || docPathLower.startsWith(relPrefix)) {
          b.filePath = '';
          boardCacheStore.markDirty(boardId);
          cleanupPromises.push(
            boardCacheStore
              .flushDirty(boardId)
              .then(() => boardStore.cleanupMissingBoardAsync(boardId)),
          );
        }
      }
      // Every cleanup lands BEFORE the cascade flush, so a still-mounted tab
      // can't race the tree refresh below.
      await Promise.allSettled(cleanupPromises);
      if (!isStillSameVault(deleteIdentity)) return true;
      // Every note under the item goes missing and nothing queued for it may
      // recreate it; search stops finding it.
      noteStore.forgetDeleted(rel);
      await reindexUnder(rel);
      const deleteCascadeFlush = await boardCacheStore.flushAllDirty();
      if (deleteCascadeFlush.failed.length > 0) {
        uiStore.pushToast({
          text: `Moved to Filo's trash, but ${deleteCascadeFlush.failed.length} board file${deleteCascadeFlush.failed.length === 1 ? '' : 's'} failed to update: ${deleteCascadeFlush.failed.join(', ')}. Re-save the affected boards.`,
          type: 'error',
          duration: 0,
        });
      }
      if (!tagsDropFlushOk) {
        uiStore.pushToast({
          text: `"${rel}" was moved to Filo's trash, but its tag-membership update didn't persist. It'll be cleaned up automatically on the next vault open.`,
          type: 'warning',
          duration: 0,
        });
      }
      await ctx.refreshTree();
      ctx.clearSelection();
      if (noBoardUndo && command) {
        toastMovedToTrash(itemName, () => historyStore.runOffStack(() => command.undo(), `Undo ${command.description}`));
      }
      return true;
    }, { paths: [itemPath] });
  } catch (err) {
    if (err instanceof PendingWritesFailedError) {
      // The drain already toasted; the sidebar keeps the row.
      return false;
    }
    throw err;
  }
}
