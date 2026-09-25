import type { Editor } from '@tiptap/core';

/**
 * Toggle a TipTap editor's editability WITHOUT emitting an `update` event.
 *
 * TipTap's `editor.setEditable(editable, emitUpdate = true)` emits `update` by
 * default, which runs Filo's `onUpdate` handlers → the note view's edit hook
 * + a debounced markdown write of whatever the editor currently holds. Called
 * from a `$effect` (the close-drain gate), that store read+write inside the
 * effect is an `effect_update_depth_exceeded` loop that can turn into a phantom
 * write (e.g. flipping a CRLF note to LF just by opening it). Called from a hydrate-retry path it would schedule a write of the still-empty
 * editor. Editability is UI state, never content — so never emit.
 *
 * All callers go through this helper; `editorSetEditableDiscipline.test.ts`
 * forbids a raw `.setEditable(` anywhere else in `src/renderer`.
 */
export function setEditorEditable(editor: Editor | null | undefined, editable: boolean): void {
  if (!editor || editor.isDestroyed) return;
  if (editor.isEditable === editable) return;
  editor.setEditable(editable, false);
}
