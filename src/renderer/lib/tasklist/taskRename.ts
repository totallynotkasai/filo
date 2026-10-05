/**
 * A task's new title, from its row. The title is the task note's frontmatter
 * `title:`, one undo step on the board; a note still under the placeholder
 * name Filo made it with ("New Task 2.md") takes the title as its file name
 * in the same step (`placeholderNames.ts`). Any other note keeps its name.
 */
import { UpdateTitleCommand } from '../../commands/index';
import { historyStore } from '../../stores/history.svelte';
import { withPlaceholderRename } from '../notes/placeholderNames';

export async function renameTaskTitle(boardId: string, tile: { id: string; title: string }, notePath: string, newTitle: string): Promise<void> {
  const title = newTitle.trim();
  if (!title || title === tile.title || !notePath) return;
  const titleStep = new UpdateTitleCommand({
    tileId: tile.id,
    boardId,
    notePath,
    oldTitle: tile.title,
    newTitle: title,
    oldTitleHtml: undefined,
    newTitleHtml: undefined,
  });
  await historyStore.execute(withPlaceholderRename(titleStep, notePath, title, boardId)).catch(() => {});
}
