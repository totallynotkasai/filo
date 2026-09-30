/**
 * True while a modal dialog (a `<dialog>` opened with `showModal`, or any
 * element marked `aria-modal="true"`: a confirm, the Board Browser, a save
 * prompt) is up. App shortcuts leave the board behind it alone meanwhile: the
 * user can't see what Ctrl+Z or Ctrl+W would change.
 */
export function isModalDialogOpen(doc: Document = document): boolean {
  return doc.querySelector('[aria-modal="true"], dialog[open]') !== null;
}
