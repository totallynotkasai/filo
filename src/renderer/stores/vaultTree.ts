import type { FileTreeNode, VaultSortField, VaultSortDirection, VaultGroupField } from '../../shared/types';
import type { VaultContext } from './vaultStoreTypes';

/**
 * Vault slice — file-tree UI state: search query, sort/group config, expanded
 * folders, and multi-selection. Mutations route through the orchestrator's
 * `markMetaDirty()` so config changes are debounced into `.filo/app.json`.
 */
export function makeTreeSlice(ctx: VaultContext) {
  return {
    setSortField(field: VaultSortField): void {
      const project = ctx.getProject();
      if (!project?.settings.general) return;
      if (project.settings.general.sidebarSortField === field) return;
      project.settings.general.sidebarSortField = field;
      ctx.markMetaDirty();
    },

    setSortDirection(direction: VaultSortDirection): void {
      const project = ctx.getProject();
      if (!project?.settings.general) return;
      if (project.settings.general.sidebarSortDirection === direction) return;
      project.settings.general.sidebarSortDirection = direction;
      ctx.markMetaDirty();
    },

    setGroupField(field: VaultGroupField): void {
      const project = ctx.getProject();
      if (!project?.settings.general) return;
      if (project.settings.general.sidebarGroupField === field) return;
      project.settings.general.sidebarGroupField = field;
      ctx.markMetaDirty();
    },

    setGroupDirection(direction: VaultSortDirection): void {
      const project = ctx.getProject();
      if (!project?.settings.general) return;
      if (project.settings.general.sidebarGroupDirection === direction) return;
      project.settings.general.sidebarGroupDirection = direction;
      ctx.markMetaDirty();
    },

    toggleFolder(path: string): void {
      const next = new Set(ctx.getExpandedFolders());
      if (next.has(path)) next.delete(path);
      else next.add(path);
      ctx.setExpandedFolders(next);
    },

    expandAll(): void {
      const paths = new Set<string>();
      function collect(nodes: FileTreeNode[]) {
        for (const node of nodes) {
          if (node.isDirectory) {
            paths.add(node.path);
            if (node.children) collect(node.children);
          }
        }
      }
      collect(ctx.getFileTree());
      ctx.setExpandedFolders(paths);
    },

    collapseAll(): void {
      ctx.setExpandedFolders(new Set());
    },

    isSelected(path: string): boolean {
      return ctx.getSelectedPaths().has(path);
    },

    selectOnly(path: string): void {
      ctx.setSelectedPaths(new Set([path]));
    },

    toggleSelection(path: string): void {
      const next = new Set(ctx.getSelectedPaths());
      if (next.has(path)) next.delete(path);
      else next.add(path);
      ctx.setSelectedPaths(next);
    },
  };
}
