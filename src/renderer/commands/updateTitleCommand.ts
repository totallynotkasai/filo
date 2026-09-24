/**
 * Undoable title edit.
 *
 * - A text tile's title is its note's frontmatter `title:`. The edit is a
 *   frontmatter change `{ title }` written through the delta path (a fresh
 *   disk read, only that key rewritten); the file is never renamed. Undo
 *   restores the prior `title:`, or removes the key when the note had none.
 * - Every other tile owns its title on the board, so the edit is a board
 *   update.
 * - `titleHtml` (the formatted title) is visual, so it always lives on the
 *   board and moves with the title in both directions.
 */

import { Command } from './Command';
import { UpdateCardFieldCommand } from './kanbanCommands';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { noteFrontmatter, titleFromFrontmatter } from '../stores/noteMeta';
import type { Tile } from '../schema/index';

export interface UpdateTitleArgs {
  tileId: string;
  /** The tile's home board. */
  boardId: string;
  /** The note's path for a text tile; `null` for a tile that owns its title. */
  notePath: string | null;
  oldTitle: string;
  newTitle: string;
  oldTitleHtml: string | undefined;
  newTitleHtml: string | undefined;
}

export class UpdateTitleCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private args: UpdateTitleArgs;
  /** The frontmatter half, for a note's title. */
  private field: UpdateCardFieldCommand | null = null;

  constructor(args: UpdateTitleArgs) {
    super();
    this.args = this.snapshot(args);
    this.targetBoardId = args.boardId;
    this.description = `Rename to "${args.newTitle}"`;
    if (args.notePath && args.newTitle !== args.oldTitle) {
      // The inverse is recaptured from a fresh disk read on first execute; this
      // one only covers the case where that read can't run.
      const priorTitle = titleFromFrontmatter(noteFrontmatter(args.notePath));
      this.field = new UpdateCardFieldCommand(
        args.boardId,
        args.notePath,
        args.notePath,
        { title: args.newTitle },
        { title: priorTitle ?? '' },
        this.description,
      );
    }
  }

  async execute(): Promise<void> {
    await this.field?.execute();
    this.applyBoardSide(this.args.newTitle, this.args.newTitleHtml);
  }

  async undo(): Promise<void> {
    await this.field?.undo();
    this.applyBoardSide(this.args.oldTitle, this.args.oldTitleHtml);
  }

  private applyBoardSide(title: string, titleHtml: string | undefined): void {
    const patch: Partial<Tile> = this.args.notePath ? { titleHtml } : { title, titleHtml };
    if (boardStore.getTile(this.args.tileId)) {
      boardStore.updateTile(this.args.tileId, patch);
    } else {
      // Kanban / Task List rows and a tile whose board isn't the active one
      // are written through the cache of their home board.
      boardCacheStore.persistUpdateTile(this.args.tileId, patch, this.args.boardId);
    }
  }
}
