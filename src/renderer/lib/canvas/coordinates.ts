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
