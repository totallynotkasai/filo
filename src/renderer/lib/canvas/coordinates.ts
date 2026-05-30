import type { CanvasTransform } from '../../stores/canvas.svelte';

/**
 * Coordinate transformation utilities for screen ↔ canvas conversions.
 */

/**
 * Converts screen (pixel) coordinates to canvas coordinates.
 */
export function screenToCanvas(
  screenX: number,
  screenY: number,
  transform: CanvasTransform,
): { x: number; y: number } {
  return {
    x: (screenX - transform.x) / transform.scale,
    y: (screenY - transform.y) / transform.scale,
  };
}

/**
 * Gets canvas coordinates from a mouse/pointer event.
 * Pass the event and the canvas container's bounding rect offset.
 */
export function getCanvasPointFromEvent(
  e: MouseEvent | PointerEvent,
  transform: CanvasTransform,
  containerRect?: DOMRect,
): { x: number; y: number } {
  const offsetX = containerRect ? containerRect.left : 0;
  const offsetY = containerRect ? containerRect.top : 0;
  return screenToCanvas(e.clientX - offsetX, e.clientY - offsetY, transform);
}
