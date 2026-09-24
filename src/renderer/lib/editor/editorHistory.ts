import type { Editor } from '@tiptap/core';
import type { Plugin } from '@tiptap/pm/state';

/**
 * Drop the editor's undo/redo stacks WITHOUT emitting a
 * transaction.
 *
 * A full-document load (hydrate or reload) is a history boundary: Ctrl+Z must
 * never cross it. Without this, undo right after opening a note would empty it,
 * and undo after an external (e.g. OneDrive) reload would resurrect the
 * pre-reload text — and either result would be autosaved. `addToHistory: false` on the load alone is not
 * enough: an earlier user event survives, remapped, so `can().undo()` stays true.
 *
 * Technique: the same one TipTap's own `registerPlugin` uses — reconfigure the
 * state without the history plugin (its state is discarded), then reconfigure it
 * back in with fresh, empty stacks, and hand the result to `view.updateState`.
 * That bypasses TipTap's transaction events on purpose (no `onUpdate`, no
 * `onTransaction`); the selection survives `reconfigure`.
 *
 * Trade-off (accepted): a clean split-pane sibling that reloads another pane's
 * keystrokes loses its own, already-saved undo history on each reload.
 */
export function resetEditorHistory(editor: Editor): void {
  if (!editor || editor.isDestroyed) return;
  const view = (editor as { view?: Editor['view'] }).view;
  const state = view?.state;
  // Test stubs / label editors expose no ProseMirror view or plugins.
  if (!view || !state || !Array.isArray(state.plugins)) return;
  const isHistory = (p: Plugin): boolean =>
    String((p as { key?: unknown }).key ?? '').startsWith('history$');
  if (!state.plugins.some(isHistory)) return;
  const without = state.reconfigure({ plugins: state.plugins.filter((p) => !isHistory(p)) });
  view.updateState(without.reconfigure({ plugins: state.plugins }));
}
