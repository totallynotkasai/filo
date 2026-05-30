import type { Frame } from '../../schema/index';

const FRAME_HEADER_HEIGHT = 32;

/**
 * Return the topmost frame that the (canvasX, canvasY) point lies within,
 * or null. Iterates last-to-first so the visually topmost frame wins. When
 * a frame is collapsed, only its header strip is considered hittable.
 */
export function hitTestFrame(
  canvasX: number,
  canvasY: number,
  frames: readonly Frame[],
): Frame | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const bottom = f.position.y + (f.collapsed ? FRAME_HEADER_HEIGHT : f.size.height);
    if (
      canvasX >= f.position.x &&
      canvasX <= f.position.x + f.size.width &&
      canvasY >= f.position.y &&
      canvasY <= bottom
    ) {
      return f;
    }
  }
  return null;
}
