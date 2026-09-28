/**
 * Unsaved theme-editor work, asked about before it goes.
 *
 * The theme editor lives inside Settings → Themes. Switching to another tab,
 * or closing Settings (Escape, the close button), unmounts it, and its
 * colours were only a preview. The open editor registers here, and those
 * exits call `settleThemeEditor` first: Save, Discard, or Cancel (stay).
 */
import { uiStore } from '../../stores/ui.svelte';

export interface OpenThemeEditor {
  /** The theme's name as the editor shows it. */
  name(): string;
  /** Whether anything differs from what the editor opened with. */
  isDirty(): boolean;
  /** Saves; resolves false when nothing was saved (a problem is shown). */
  save(): Promise<boolean>;
}

let openEditor: OpenThemeEditor | null = null;

/** Registers the mounted editor; the returned function unregisters it. */
export function registerThemeEditor(editor: OpenThemeEditor): () => void {
  openEditor = editor;
  return () => {
    if (openEditor === editor) openEditor = null;
  };
}

/** Whether an open theme editor holds changes that aren't saved. */
export function themeEditorHasChanges(): boolean {
  return openEditor?.isDirty() ?? false;
}

/**
 * Resolves true when the editor may go: nothing open, nothing changed, or the
 * user chose Save (and it saved) or Discard. False keeps the editor open.
 */
export function settleThemeEditor(ui: typeof uiStore = uiStore): Promise<boolean> {
  const editor = openEditor;
  if (!editor || !editor.isDirty()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    ui.openConfirm({
      title: 'Save changes to the theme?',
      body: `"${editor.name()}" has changes that aren't saved. Discarding them puts the active theme back.`,
      confirmLabel: 'Save',
      cancelLabel: 'Keep editing',
      secondaryAction: { label: 'Discard', onClick: () => resolve(true) },
      onConfirm: () => {
        void editor.save().then(resolve, () => resolve(false));
      },
      onCancel: () => resolve(false),
    });
  });
}
