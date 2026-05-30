import type { Project } from '../schema/index';
import type { VaultContext } from './vaultStoreTypes';

/**
 * Vault slice — project-level metadata accessors and mutators. The project
 * is the virtual aggregator that other stores (boardStore) lookup their
 * cached connections/frames against; `setName` / `setTheme` are persisted
 * through `markMetaDirty`.
 */
export function makeProjectSlice(ctx: VaultContext) {
  return {
    setName(name: string): void {
      const project = ctx.getProject();
      if (!project) return;
      project.name = name;
      ctx.markMetaDirty();
    },

    setTheme(theme: Project['theme']): void {
      const project = ctx.getProject();
      if (!project) return;
      project.theme = theme;
      document.documentElement.setAttribute('data-theme', theme);
      ctx.markMetaDirty();
    },

    /** Direct mutation access for the virtual Project (used by boardStore when it
     *  mutates board/connection/frame collections). */
    getProject(): Project | null {
      return ctx.getProject();
    },

    /** Returns the virtual Project. */
    getData(): Project | null {
      return ctx.getProject();
    },
  };
}
