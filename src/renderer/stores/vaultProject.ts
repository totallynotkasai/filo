import type { Project } from '../schema/index';
import type { VaultContext } from './vaultStoreTypes';

/**
 * Vault slice — project-level metadata accessors and mutators: the vault's
 * name, theme, settings and board list. A board's connections and frames
 * live only in its cache entry. `setName` / `setTheme` are persisted
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

    /**
     * Records the active theme id (built-in or custom) for `appearance.json`.
     * Painting it is the theme store's job: a custom id is not a
     * `data-theme` value.
     */
    setTheme(theme: string): void {
      const project = ctx.getProject();
      if (!project) return;
      project.theme = theme;
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
