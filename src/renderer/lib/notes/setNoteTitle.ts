import { UpdateCardFieldCommand } from '../../commands/index';
import { historyStore } from '../../stores/history.svelte';
import { noteDocId, noteFrontmatter, noteTitle, titleFromFrontmatter } from '../../stores/noteMeta';

/**
 * Sets the title of the note at `path` from a surface that isn't a tile (a
 * Document tab). The title is the note's frontmatter `title:`: an undoable
 * frontmatter change on `undoBoardId`'s history, never a file rename.
 */
export async function setNoteTitle(path: string, title: string, undoBoardId: string): Promise<void> {
  const next = title.trim();
  if (!path || !next || next === noteTitle(path)) return;
  const prior = titleFromFrontmatter(noteFrontmatter(path));
  await historyStore
    .execute(new UpdateCardFieldCommand(undoBoardId, path, noteDocId(path), { title: next }, { title: prior ?? '' }, `Rename to "${next}"`))
    .catch(() => {});
}
