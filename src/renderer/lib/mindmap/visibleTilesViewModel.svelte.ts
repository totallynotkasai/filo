import { SvelteSet } from 'svelte/reactivity';
import type { CanvasScope } from '../../stores/canvas.svelte';
import type { SpatialScope } from '../../stores/spatial.svelte';
import type { BoardScopeBoard } from '../../stores/board.svelte';
import type { Tile } from '../../schema/index';
import { vaultStore } from '../../stores/vault.svelte';
import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
import { framesStore } from '../../stores/frames.svelte';
import { recordingTiles, runningTimerTiles } from '../../stores/tiles.svelte';

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
    const visible = new SvelteSet(ids);
    // A recording tile stays mounted off screen: unmounting it would stop the
    // take in the middle of a pan.
    for (const id of recordingTiles) {
      if (this.deps.board.tiles[id]) visible.add(id);
    }
    // So does a running countdown: culled, it would end without a word.
    for (const id of runningTimerTiles) {
      if (this.deps.board.tiles[id]) visible.add(id);
    }
    // And the tile holding the keyboard focus: culled, its element would take
    // the focus out of the canvas to the page, where the board's keys (N, C,
    // Enter, the arrows) don't act.
    const focused = this.focusedTileId;
    if (focused && this.deps.board.tiles[focused]) visible.add(focused);
    return visible;
  });

  /** The tile holding the keyboard focus, if any (`focusMovedTo`). */
  private focusedTileId = $state<string | null>(null);

  /**
   * The board's focusin (the element focused) and focusout (the element the
   * focus goes to, null when it leaves the page): notes which tile, if any,
   * now holds the focus.
   */
  focusMovedTo(target: EventTarget | null): void {
    const shell = target instanceof Element ? target.closest('[data-canvas-tile-id]') : null;
    this.focusedTileId = shell?.getAttribute('data-canvas-tile-id') ?? null;
  }

  hiddenByFrame = $derived(framesStore.hiddenTileIds);

  /**
   * Stable id→insertion-index map for the visible-tile sort
   * below. Built from `board.tiles`' key order (insertion order = the canvas
   * paint/stacking order for tiles sharing the `--z-tile` z-index) and
   * recomputed ONLY when the tile SET changes. A pure pan mutates
   * `canvas.viewportRect`, not `board.tiles`, so this derived stays cached and
   * the hot pan path never pays its O(n) rebuild.
   */
  private tileOrder = $derived.by(() => {
    // Non-reactive computation result — rebuilt wholesale when the tile set
    // changes, never mutated in place after; reactivity comes from the
    // enclosing `$derived`, so a plain Map (not SvelteMap) is correct.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const order = new Map<string, number>();
    let i = 0;
    for (const id of Object.keys(this.deps.board.tiles)) order.set(id, i++);
    return order;
  });

  /**
   * Builds the visible set by mapping over the culled
   * `visibleTileIds` (size = on-screen tiles) instead of filtering EVERY tile on
   * the board. A pan re-derives this on every viewport change, so this is
   * O(visible) rather than O(total tiles) per frame. Re-sorted into insertion order so overlapping
   * same-z-index tiles keep their current DOM-order stacking.
   */
  visibleTiles = $derived.by(() => {
    const tiles = this.deps.board.tiles;
    const order = this.tileOrder;
    const out: Tile[] = [];
    for (const id of this.visibleTileIds) {
      const tile = tiles[id];
      if (tile && !this.hiddenByFrame.has(tile.id)) out.push(tile);
    }
    out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return out;
  });

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
