import type { Editor } from '@tiptap/core';

/**
 * Toggle a TipTap editor's editability WITHOUT emitting an `update` event.
 *
 * TipTap's `editor.setEditable(editable, emitUpdate = true)` emits `update` by
 * default, which runs Filo's `onUpdate` handlers → `documentStore.updateContent`
 * + a debounced markdown write of whatever the editor currently holds. Called
 * from a `$effect` (the close-drain gate), that store read+write inside the
 * effect is an `effect_update_depth_exceeded` loop; under svelte 5.57.1 the
 * loop re-ran after hydrate and turned into a phantom write that flipped a CRLF
 * note to LF just by opening it (DEPENDENCY_UPGRADE_REPORT_2026-09-23 §0.2).
 * Called from a hydrate-retry path it would schedule a write of the still-empty
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
