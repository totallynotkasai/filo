/**
 * "New note": a note made on its own, not for a board. The sidebar's menus,
 * Ctrl+N in a Document tab and New Tab → Document all come here.
 *
 * The note is made at once as `Untitled.md` (` (n)` past a taken name), with
 * no `title:`, and opens in a Document tab whose title is open for typing.
 * The title typed is written as its `title:` and names the file too, as for
 * a new card (`placeholderNames.ts`). Escape leaves it named by its file, so
 * renaming the file in the sidebar names the note.
 */
import { createNoteFile } from './createNote';
import { editTitleWhenShown } from '../boards/newTileTitle';
import { reportError } from '../utils/errorBus';
import { vaultStore } from '../../stores/vault.svelte';
import { tabStore } from '../../stores/tabs.svelte';

export const NEW_NOTE_TITLE = 'Untitled';

/** Makes a new note in `folder` (vault-relative, `''` for the top) and opens it; its path, or null. */
export async function createNewNote(folder: string): Promise<string | null> {
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return null;
  try {
    // DECISION: no `title:` until the note is named, so a rename of the file
    // in the sidebar names it (a written "Untitled" would outlive the rename).
    const { relPath } = await createNoteFile({ vaultRoot, folder, title: NEW_NOTE_TITLE, writeTitle: false });
    if (vaultStore.path !== vaultRoot) return null;
    const tab = tabStore.openNote(relPath, NEW_NOTE_TITLE);
    editTitleWhenShown(tab.id);
    return relPath;
  } catch (err) {
    reportError('newNote.create', err, folder ? `Couldn't make a new note in "${folder}"` : "Couldn't make a new note");
    return null;
  }
}

/** The folder of the note at `relPath` (`''` at the vault's top): where a note made beside it goes. */
export function folderOfNote(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash >= 0 ? relPath.slice(0, slash) : '';
}
