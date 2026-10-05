import { UpdateCardFieldCommand } from '../../commands/index';
import { historyStore } from '../../stores/history.svelte';
import { noteFrontmatter, noteTitle, titleFromFrontmatter } from '../../stores/noteMeta';
import { withPlaceholderRename } from './placeholderNames';

/**
 * Sets the title of the note at `path` from a surface that isn't a tile (a
 * Document tab). The title is the note's frontmatter `title:`: an undoable
 * frontmatter change on `undoBoardId`'s history. The file keeps its name,
 * unless it still has the placeholder name Filo made it under ("Untitled.md").
 */
export async function setNoteTitle(path: string, title: string, undoBoardId: string): Promise<void> {
  const next = title.trim();
  if (!path || !next || next === noteTitle(path)) return;
  const prior = titleFromFrontmatter(noteFrontmatter(path));
  const titleStep = new UpdateCardFieldCommand(undoBoardId, path, { title: next }, { title: prior ?? '' }, `Rename to "${next}"`);
  await historyStore.execute(withPlaceholderRename(titleStep, path, next, undoBoardId)).catch(() => {});
}
