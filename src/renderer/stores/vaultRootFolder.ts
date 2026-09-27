import { boardStore } from './board.svelte';
import { flattenTreePaths } from '../lib/vault/vaultTreeSort';
import { normalizePath, samePath, stripLeadingSlash, toVaultRelative } from '../lib/utils/path';
import { pinIsUnder } from '../lib/vault/folderPinPaths';
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

      const deletedRel =
        toVaultRelative(deletedPath, vaultPath) ?? stripLeadingSlash(normalizePath(deletedPath));

      if (!deletedRel) return;
      if (pinIsUnder(current, deletedRel)) {
        project.settings.general.activeRootFolder = '';
        ctx.markMetaDirty();
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
      const rel = toVaultRelative(absPath, vaultPath) ?? '';
      const current = project.settings.general?.activeRootFolder ?? '';
      const next = samePath(rel, current) ? '' : rel;
      if (!project.settings.general) return;
      project.settings.general.activeRootFolder = next;
      ctx.markMetaDirty();
    },

    /**
     * Triggers an immediate broken-ref recompute against the current file tree,
     * for a caller that learned of a change before the next refreshTree (a
     * note found missing on read, a board adopted mid-session).
     */
    recomputeBrokenRefsNow(): void {
      const vaultPath = ctx.getVaultPath();
      if (!vaultPath) return;
      boardStore.recomputeBrokenRefs(flattenTreePaths(ctx.getFileTree(), vaultPath));
    },
  };
}
