/**
 * Whether a press on a Mind Map landed on its empty canvas: the board itself,
 * its transform layer, the background pattern, or a frame's empty body.
 *
 * A frame body draws nothing of its own (`.frame-body` takes no pointer
 * events, so a press there lands on `.frame-container`): a press inside a
 * frame that no tile, header or resize handle took is a press on the canvas,
 * and pans, focuses the board and clears the selection as it would outside
 * the frame. Without it the frame swallowed the press and nothing happened.
 */
export function isCanvasBackground(target: EventTarget | null, board: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  return target === board
    || target.classList.contains('canvas-transform')
    || target.classList.contains('frame-container')
    || target.closest('.board-background') !== null;
}
