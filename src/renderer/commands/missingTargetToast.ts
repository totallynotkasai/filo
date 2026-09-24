import { uiStore } from '../stores/ui.svelte';

/**
 * Uniform "the target no longer exists" toast for undo/redo.
 *
 * When a single-target command's tile / column was deleted out-of-band, the
 * underlying `boardStore.updateTile` / `persistAddKanbanPlacement` silently
 * returns; this toast makes an undo / redo that didn't apply visible.
 *
 * `phase` is `'redo'` on the execute() leg and `'undo'` on the undo() leg —
 * the very first execute() can't reach this path (you can't edit a target that
 * isn't there), so by the time it fires the user is always redoing.
 */
export function toastMissingUndoRedoTarget(phase: 'redo' | 'undo', target: string): void {
  uiStore.toast(`Cannot ${phase} — ${target} no longer exists.`, 'warning', 4000);
}
