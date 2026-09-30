import { SvelteSet } from 'svelte/reactivity';
import type { CanvasScope } from '../../stores/canvas.svelte';
import type { SelectionScope } from '../../stores/selection.svelte';
import type { SpatialScope } from '../../stores/spatial.svelte';
import { connectionsStore } from '../../stores/connections.svelte';
import { screenToCanvas } from '../canvas/coordinates';

/**
 * Per-pane marquee-selection controller. Receives the pane's `canvas`,
 * `selection`, and `spatial` scopes so shift-drag selection in one pane
 * doesn't leak into the other pane's state.
 */
export class MarqueeSelectionController {
  isSelecting = $state(false);
  shiftPressed = $state(false);

  private container: HTMLElement | null = null;
  private readonly canvasScope: CanvasScope;
  private readonly selectionScope: SelectionScope;
  private readonly spatialScope: SpatialScope;
  private readonly hiddenTileIds: () => ReadonlySet<string>;

  constructor(deps: {
    canvas: CanvasScope;
    selection: SelectionScope;
    spatial: SpatialScope;
    /** Tiles inside a collapsed frame: not drawn, so never box-selected. */
    hiddenTileIds?: () => ReadonlySet<string>;
  }) {
    this.canvasScope = deps.canvas;
    this.selectionScope = deps.selection;
    this.spatialScope = deps.spatial;
    this.hiddenTileIds = deps.hiddenTileIds ?? (() => new SvelteSet<string>());
  }

  setContainer(el: HTMLElement | null): void {
    this.container = el;
  }

  setShiftPressed(pressed: boolean): void {
    this.shiftPressed = pressed;
  }

  handlePointerDown(e: PointerEvent): void {
    if (!this.container) return;
    if (!e.shiftKey || e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();
    this.isSelecting = true;

    const rect = this.container.getBoundingClientRect();
    const canvasPos = screenToCanvas(
      e.clientX - rect.left,
      e.clientY - rect.top,
      this.canvasScope.transform,
    );
    this.selectionScope.startBox(canvasPos.x, canvasPos.y);

    this.container.setPointerCapture(e.pointerId);
  }

  handlePointerMove(e: PointerEvent): void {
    if (!this.container) return;

    // Selection box update
    if (this.isSelecting) {
      const rect = this.container.getBoundingClientRect();
      const canvasPos = screenToCanvas(
        e.clientX - rect.left,
        e.clientY - rect.top,
        this.canvasScope.transform,
      );
      this.selectionScope.updateBox(canvasPos.x, canvasPos.y);

      const box = this.selectionScope.boxRect;
      if (box) {
        const ids = this.spatialScope.queryViewport({
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
        });
        const hidden = this.hiddenTileIds();
        this.selectionScope.selectMultiple(ids.filter((id) => !hidden.has(id)));
      }
    }

    // Connection drawing line follows mouse
    if (connectionsStore.drawing) {
      const rect = this.container.getBoundingClientRect();
      const canvasPos = screenToCanvas(
        e.clientX - rect.left,
        e.clientY - rect.top,
        this.canvasScope.transform,
      );
      connectionsStore.updateDrawing(canvasPos.x, canvasPos.y);
    }
  }

  handlePointerUp(e: PointerEvent): void {
    if (!this.isSelecting) return;
    this.isSelecting = false;
    this.selectionScope.endBox();
    this.container?.releasePointerCapture(e.pointerId);
  }

  /**
   * The system took the pointer (a touch turned into a scroll, a window
   * switch): the box goes away, keeping what it had selected, so it isn't
   * left drawn and following the next move.
   */
  handlePointerCancel(): void {
    if (!this.isSelecting) return;
    this.isSelecting = false;
    this.selectionScope.endBox();
  }
}
