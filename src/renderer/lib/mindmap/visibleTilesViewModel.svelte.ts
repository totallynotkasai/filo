import { SvelteSet } from 'svelte/reactivity';
import type { CanvasScope } from '../../stores/canvas.svelte';
import type { SpatialScope } from '../../stores/spatial.svelte';
import type { BoardScopeBoard } from '../../stores/board.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
import { framesStore } from '../../stores/frames.svelte';

const VIEWPORT_CULL_BUFFER = 200;

interface VisibleTilesDeps {
  board: BoardScopeBoard;
  canvas: CanvasScope;
  spatial: SpatialScope;
}

/**
 * Per-pane viewport-culling view model. The board / canvas / spatial scopes
 * are passed in by `MindMapBoard` so the model derives from THIS pane's
 * state (not the active scope's). Two split panes can therefore compute
 * independent visible-tile sets — important for performance (each pane
 * only renders what's in its own viewport) and correctness (the inactive
 * pane doesn't render the active pane's culled set).
 *
 * `deps` is marked with `!` for definite assignment because the `$derived`
 * field initializers below capture `this` lazily — they only read
 * `this.deps` when the derived value is first accessed, which is after the
 * constructor has finished. Without `!`, TypeScript's
 * `strictPropertyInitialization` flags the captured references as
 * "used before initialization."
 */
export class VisibleTilesViewModel {
  private deps!: VisibleTilesDeps;

  constructor(deps: VisibleTilesDeps) {
    this.deps = deps;
  }

  visibleTileIds = $derived.by(() => {
    const vp = this.deps.canvas.viewportRect;
    const ids = this.deps.spatial.queryViewport({
      left: vp.left - VIEWPORT_CULL_BUFFER,
      top: vp.top - VIEWPORT_CULL_BUFFER,
      right: vp.right + VIEWPORT_CULL_BUFFER,
      bottom: vp.bottom + VIEWPORT_CULL_BUFFER,
    });
    return new SvelteSet(ids);
  });

  hiddenByFrame = $derived(framesStore.hiddenTileIds);

  visibleTiles = $derived.by(() =>
    this.deps.canvas.exportMode
      ? Object.values(this.deps.board.tiles).filter((t) => !this.hiddenByFrame.has(t.id))
      : Object.values(this.deps.board.tiles).filter(
          (t) => this.visibleTileIds.has(t.id) && !this.hiddenByFrame.has(t.id),
        ),
  );

  isBoardEmpty = $derived(
    Object.keys(this.deps.board.tiles).length === 0 && this.deps.board.frames.length === 0,
  );

  bgPattern = $derived.by(() => {
    if (this.deps.board.current?.type !== 'mindmap') return 'grid';
    const eff = pendingSettingsStore.effectiveBoardSettings as
      | { backgroundPattern?: 'grid' | 'dots' | 'lines' | 'none' }
      | null;
    const eg = pendingSettingsStore.effective as
      | { mindmap?: { backgroundPattern?: 'grid' | 'dots' | 'lines' | 'none' } }
      | null;
    return (
      eff?.backgroundPattern
      ?? this.deps.board.current.settings.backgroundPattern
      ?? eg?.mindmap?.backgroundPattern
      ?? vaultStore.project?.settings?.mindmap?.backgroundPattern
      ?? 'grid'
    );
  });

  bgColor = $derived.by(() => {
    if (this.deps.board.current?.type !== 'mindmap') return '';
    const eff = pendingSettingsStore.effectiveBoardSettings as
      | { backgroundColor?: string }
      | null;
    const board = eff?.backgroundColor ?? this.deps.board.current.settings.backgroundColor;
    if (board) return board;
    const eg = pendingSettingsStore.effective as
      | { mindmap?: { backgroundColor?: string } }
      | null;
    return (
      eg?.mindmap?.backgroundColor ??
      vaultStore.project?.settings?.mindmap?.backgroundColor ??
      ''
    );
  });
}
