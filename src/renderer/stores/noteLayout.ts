/**
 * noteLayout — whole-note display settings that live in the note's
 * frontmatter, so they travel with the file and every view of the note shows
 * the same thing. Today that is line spacing (`lineSpacing:`).
 */
import { historyStore } from './history.svelte';
import { noteLineSpacing } from './noteMeta';
import { SetLineSpacingCommand } from '../commands/noteLayoutCommands';

/**
 * Sets the note's line spacing as one undoable step. `historyBoardId` is the
 * board, or Document tab, the edit was made in (the command's target). `null`
 * removes the key, so each view uses its default again. No-op when nothing
 * changes.
 */
export function setNoteLineSpacing(historyBoardId: string, relPath: string, value: number | null): void {
  if (!relPath) return;
  const before = noteLineSpacing(relPath);
  if (before === value) return;
  // A failure is reported and rolled back by the history store.
  historyStore.execute(new SetLineSpacingCommand(historyBoardId, relPath, value, before)).catch(() => {});
}
