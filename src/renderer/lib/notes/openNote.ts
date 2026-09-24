import { documentStore } from '../../stores/document.svelte';
import { tabStore } from '../../stores/tabs.svelte';
import { noteTitle } from '../../stores/noteMeta';

/**
 * Opens the note at `path` in a Document tab, or focuses the tab that already
 * shows it. Every view of one path shares one document, keyed by that path.
 *
 * The placeholder `DocumentState` has no body; the editor reads the file on
 * mount. It is registered only when no view holds the note yet, so a loaded
 * body is never replaced by an empty one.
 */
export function openNoteInDocumentTab(path: string): void {
  if (!path) return;
  const title = noteTitle(path);
  const existing = documentStore.getDocument(path);
  if (!existing) {
    documentStore.loadDocument({
      filename: path,
      title,
      body: '',
      htmlContent: '',
      richText: [],
    });
  }
  documentStore.openDocumentTab(path);
  tabStore.openNote(existing?.filename ?? path, title || 'Document');
}
