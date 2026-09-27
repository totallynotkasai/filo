import type { BoardType } from '../../shared/types';
import { boardRegistry, type BoardComponentLoader } from './boardRegistry';

type BoardModule = Awaited<ReturnType<BoardComponentLoader>>;

// allow-module-state: loaded code modules are not vault data; they stay valid across vault swaps
const loadedBoardModules = new Map<BoardType, BoardModule>();

/**
 * A board type's component module: the module itself once it has loaded, a
 * promise before that. Calling the registry's loader again returns a fresh
 * `import()` promise, which settles later than the one microtask Svelte's
 * `{#await}` waits before showing its pending branch, so every open of an
 * already-loaded board flashed the loading placeholder. A plain value renders
 * at once.
 */
export function loadBoardModule(type: BoardType): BoardModule | Promise<BoardModule> {
  const loaded = loadedBoardModules.get(type);
  if (loaded) return loaded;
  return boardRegistry[type].component().then((mod) => {
    loadedBoardModules.set(type, mod);
    return mod;
  });
}

/** Loaders for every board type, for the idle preload after a vault opens. */
export function allBoardModuleLoaders(): Array<() => Promise<BoardModule>> {
  return (Object.keys(boardRegistry) as BoardType[]).map(
    (type) => async () => loadBoardModule(type),
  );
}
