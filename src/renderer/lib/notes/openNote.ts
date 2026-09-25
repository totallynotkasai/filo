import { tabStore } from '../../stores/tabs.svelte';
import { noteTitle } from '../../stores/noteMeta';

/**
 * Opens the note at `path` in a Document tab, or focuses the tab that already
 * shows it. The tab's editor acquires the note from the note store on mount,
 * sharing the model with every other view of the same path.
 */
export function openNoteInDocumentTab(path: string): void {
  if (!path) return;
  tabStore.openNote(path, noteTitle(path) || 'Document');
}
