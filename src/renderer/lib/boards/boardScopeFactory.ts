/**
 * BoardScope composer — assembles a fresh per-pane scope by calling the
 * four sub-factories. Lives in a separate file from `boardScope.svelte.ts`
 * so the primitives there (state, getters, facade Proxy) can be imported
 * by the four store modules without creating a circular runtime
 * dependency. Importing this file at app entry registers the composer as
 * the default-scope fallback that `getActiveScope` uses before any
 * `PaneView` mounts.
 */
import {
  type BoardScope,
  setDefaultScopeFactory,
} from './boardScope.svelte';
import { createBoardScopeBoard } from '../../stores/board.svelte';
import { createCanvasScope } from '../../stores/canvas.svelte';
import { createSelectionScope } from '../../stores/selection.svelte';
import { createSpatialScope } from '../../stores/spatial.svelte';

/**
 * Composes a fresh `BoardScope`. The board factory receives the other
 * three sub-scopes as dependencies so its slices can mutate the same per-
 * scope spatial index / canvas transform / selection set.
 */
export function createBoardScope(): BoardScope {
  const spatial = createSpatialScope();
  const selection = createSelectionScope();
  const canvas = createCanvasScope();
  const board = createBoardScopeBoard({ spatial, canvas, selection });
  return { board, canvas, selection, spatial };
}

// Register as the default fallback. The first call to `getActiveScope`
// before any explicit `setActiveScope` will build one of these.
setDefaultScopeFactory(createBoardScope);
