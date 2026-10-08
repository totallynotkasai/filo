import type { Frame } from '../../schema/index';

interface Rect {
  position: { x: number; y: number };
  size: { width: number; height: number };
}

function area(r: Rect): number {
  return r.size.width * r.size.height;
}

/** Whether `inner` lies wholly inside `outer` and is smaller (two equal frames don't hold each other). */
function holds(outer: Rect, inner: Rect): boolean {
  return (
    inner.position.x >= outer.position.x &&
    inner.position.y >= outer.position.y &&
    inner.position.x + inner.size.width <= outer.position.x + outer.size.width &&
    inner.position.y + inner.size.height <= outer.position.y + outer.size.height &&
    area(inner) < area(outer)
  );
}

/**
 * The frames nested in `outer`, at any depth: each lies wholly inside it.
 * They travel with it when it is dragged, with their tiles, so a frame drawn
 * inside another stays inside it.
 */
export function framesInside(outer: Frame, frames: readonly Frame[]): Frame[] {
  return frames.filter((f) => f.id !== outer.id && holds(outer, f));
}

/**
 * The frames in the order they are drawn: larger first, so a frame inside
 * another is painted (and hit) above it, whichever was made first. Frames of
 * the same size keep their order in the board. A frame inside a collapsed
 * frame is left out: folding a frame hides what it holds, its frames as well
 * as its tiles, so none is drawn as an empty box over the folded one or
 * takes a click there.
 */
export function framesInPaintOrder(frames: readonly Frame[]): Frame[] {
  const folded = frames.filter((f) => f.collapsed);
  return frames
    .filter((frame) => !folded.some((outer) => outer.id !== frame.id && holds(outer, frame)))
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => area(b.frame) - area(a.frame) || a.index - b.index)
    .map(({ frame }) => frame);
}
