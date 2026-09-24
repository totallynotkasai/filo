import type { ConfirmDialogConfig } from '../../stores/ui.svelte';

/**
 * Frame-delete confirmation builder.
 *
 * Both Frame.svelte's trash icon and MindMapBoard.svelte's context-menu
 * "Delete Frame" route here so the dialog copy stays in one place. The
 * helper is a thin wrapper rather than logic-heavy on purpose — testing
 * the gate is just about asserting "openConfirm is called with the right
 * shape and the onConfirmed callback runs on confirm".
 *
 * Tile count is surfaced because removing a frame around 30 tiles vs.
 * 0 tiles is the same on-disk operation but very different perceptually
 * — the body copy reassures that contained tiles stay on the board.
 */
export interface ConfirmRemoveFrameDeps {
  /** Bound to `uiStore.openConfirm`. */
  openConfirm: (config: ConfirmDialogConfig) => void;
  /** Fires when the user picks the Confirm button. */
  onConfirmed: () => void;
  /** Optional: how many tiles the frame currently contains. */
  tileCount?: number;
}

export function confirmRemoveFrame(deps: ConfirmRemoveFrameDeps): void {
  const { openConfirm, onConfirmed, tileCount = 0 } = deps;
  const bodyTail = tileCount > 0
    ? `Tiles inside (${tileCount}) stay on the board.`
    : 'Tiles inside remain on the board.';
  openConfirm({
    title: 'Remove frame?',
    body: `The frame container is removed. ${bodyTail} You can undo this from the toolbar.`,
    confirmLabel: 'Remove',
    danger: true,
    onConfirm: () => onConfirmed(),
  });
}
