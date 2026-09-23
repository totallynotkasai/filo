import { uiStore } from '../stores/ui.svelte';

/**
 * P4.5 (Audit-15) — uniform "the target no longer exists" toast for undo/redo.
 *
 * Several single-target commands (tile resize / style / alt / timer config,
 * add-card) historically silent-no-op'd when their target tile / column was
 * deleted out-of-band between the original edit and a later undo / redo: the
 * underlying `boardStore.updateTile` / `persistAddKanbanPlacement` simply
 * returns when the target is gone. `MoveTilesCommand` / `MoveCardCommand`
 * already surface a toast in that case; this helper gives the rest the same
 * uniform feedback so an undo / redo that didn't actually apply doesn't pass
 * unnoticed.
 *
 * `phase` is `'redo'` on the execute() leg and `'undo'` on the undo() leg —
 * the very first execute() can't reach this path (you can't edit a target that
 * isn't there), so by the time it fires the user is always redoing.
 */
export function toastMissingUndoRedoTarget(phase: 'redo' | 'undo', target: string): void {
  uiStore.toast(`Cannot ${phase} — ${target} no longer exists.`, 'warning', 4000);
}
