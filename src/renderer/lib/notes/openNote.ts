import type { BoardType } from '../../../shared/types';
import { documentStore } from '../../stores/document.svelte';
import { tabStore } from '../../stores/tabs.svelte';
import { noteDocId, noteTitle } from '../../stores/noteMeta';

/**
 * Opens the note at `path` in a Document tab, or focuses the tab that already
 * shows it. Every view of one path shares one document (see `noteIds`).
 *
 * The placeholder `DocumentState` has no body; the editor reads the file on
 * mount. It is registered only when no view holds the note yet, so a loaded
 * body is never replaced by an empty one.
 */
export function openNoteInDocumentTab(path: string): void {
  if (!path) return;
  const docId = noteDocId(path);
  const title = noteTitle(path);
  if (!documentStore.getDocument(docId)) {
    documentStore.loadDocument({
      docId,
      filename: path,
      title,
      body: '',
      htmlContent: '',
      richText: [],
    });
  }
  documentStore.openDocumentTab(docId);
  tabStore.open(docId, title || 'Document', 'document' as BoardType);
}
