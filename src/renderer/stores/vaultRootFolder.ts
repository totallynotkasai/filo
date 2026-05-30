import { boardStore } from './board.svelte';
import { flattenTreePaths } from '../lib/vault/vaultTreeSort';
import { normalizePath, stripLeadingSlash } from '../lib/utils/path';
import type { VaultContext } from './vaultStoreTypes';

/**
 * Vault slice — vault-wide active-root-folder state. Tracks which folder
 * new tiles / OS drops route into and propagates rename/delete cascades
 * through the broken-ref recompute path so badge state stays in sync.
 */
export function makeRootFolderSlice(ctx: VaultContext) {
  return {
    get activeRootFolder(): string {
      return ctx.getProject()?.settings.general?.activeRootFolder ?? '';
    },

    get activeRootFolderAbs(): string {
      const vaultPath = ctx.getVaultPath();
      if (!vaultPath) return '';
      const rel = ctx.getProject()?.settings.general?.activeRootFolder ?? '';
      if (!rel) return vaultPath;
      const root = normalizePath(vaultPath);
      return `${root}/${stripLeadingSlash(rel)}`;
    },

    /**
     * Resets `activeRootFolder` to vault root when the deleted/renamed path
     * matches the currently-marked folder (or is an ancestor of it).
     *
     * Without this, subsequent autosaves through `vault:write-file-text` and
     * `vault:copy-file` resurrect the folder via `fs.mkdir(..., { recursive: true })`
     * because the stale `activeRootFolder` setting still points at the deleted
     * path. Called from `delete()`, `rename()` (where `setActiveRootFolderTo`
     * does the propagation instead), and the watcher's tree-update handler
     * (for external deletes). Synchronous and idempotent.
     *
     * `deletedPath` may be absolute (with vault-root prefix) or vault-relative.
     */
    clearActiveRootFolderIfMatches(deletedPath: string): void {
      const project = ctx.getProject();
      const vaultPath = ctx.getVaultPath();
      if (!project?.settings.general || !vaultPath) return;
      const current = project.settings.general.activeRootFolder ?? '';
      if (!current) return;

      const root = normalizePath(vaultPath);
      const norm = normalizePath(deletedPath);
      const deletedRel = norm.startsWith(root + '/')
        ? norm.slice(root.length + 1)
        : stripLeadingSlash(norm);

      if (!deletedRel) return;
      if (current === deletedRel || current.startsWith(deletedRel + '/')) {
        project.settings.general.activeRootFolder = '';
        ctx.markMetaDirty();
        boardStore.recomputeBrokenRefs(flattenTreePaths(ctx.getFileTree(), vaultPath));
      }
    },

    /**
     * Toggles the active root folder. Passing the currently-active folder's
     * absolute path turns the toggle off (reverts to vault root); passing
     * any other folder switches the active folder to it (mutually exclusive).
     */
    setActiveRootFolder(absPath: string): void {
      const project = ctx.getProject();
      const vaultPath = ctx.getVaultPath();
      if (!project || !vaultPath) return;
      const root = normalizePath(vaultPath);
      const norm = normalizePath(absPath);
      const rel = norm === root || !norm.startsWith(root + '/')
        ? ''
        : norm.slice(root.length + 1);
      const current = project.settings.general?.activeRootFolder ?? '';
      const next = rel === current ? '' : rel;
      if (!project.settings.general) return;
      project.settings.general.activeRootFolder = next;
      ctx.markMetaDirty();
      // The convention-fallback branch of broken-ref detection reads
      // activeRootFolder. Without an explicit recompute, badge state stays
      // bound to the previous toggle value until the next refreshTree().
      boardStore.recomputeBrokenRefs(flattenTreePaths(ctx.getFileTree(), vaultPath));
    },

    /**
     * Triggers an immediate broken-ref recompute against the current file tree.
     * Used by `boardStore.setBoardDefaultFolder` (and any other caller that
     * mutates a folder-pin without going through delete/rename) so the badge
     * UI matches the new cascade output without waiting for a refreshTree.
     */
    recomputeBrokenRefsNow(): void {
      const vaultPath = ctx.getVaultPath();
      if (!vaultPath) return;
      boardStore.recomputeBrokenRefs(flattenTreePaths(ctx.getFileTree(), vaultPath));
    },
  };
}
