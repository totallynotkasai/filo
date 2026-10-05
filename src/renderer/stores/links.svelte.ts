import { decodeFiloLink, isFiloLink } from '../schema/link';
import { vaultStore } from './vault.svelte';
import { tabStore } from './tabs.svelte';
import { boardStore } from './board.svelte';
import { canvasStore } from './canvas.svelte';
import { uiStore } from './ui.svelte';
import { createId } from '../lib/utils/ids';
import { TILE_DEFAULTS, defaultTileStyleSnapshot } from '../constants/defaults';
import { navigateToTile } from '../lib/utils/navigation.svelte';
import { historyStore } from './history.svelte';
import { AddTileCommand } from '../commands/index';
import type { Tile } from '../schema/index';
import { vaultIndexStore } from './vaultIndex.svelte';
import { openNoteInDocumentTab } from '../lib/notes/openNote';

/**
 * Links store — handles navigation and actions for internal filo:// links.
 */
export const linksStore = {
  /**
   * Handles a link click. If it's a filo:// internal link, performs the action.
   * Returns true if handled, false if it should be treated as an external link.
   */
  handleLinkClick(url: string): boolean {
    if (!isFiloLink(url)) return false;

    const parsed = decodeFiloLink(url);
    if (!parsed) return false;

    switch (parsed.type) {
      case 'board-nav':
        this.navigateToBoard(parsed.targetBoardId!);
        return true;

      case 'position-nav':
        this.navigateToPosition(parsed.targetBoardId!, parsed.targetPosition!);
        return true;

      case 'tile-nav':
        if (!parsed.targetBoardId || !parsed.targetTileId) return false;
        navigateToTile(parsed.targetBoardId, parsed.targetTileId);
        return true;

      case 'note-nav':
        if (!parsed.targetPath) return false;
        this.openLinkedNote(parsed.targetPath);
        return true;

      case 'create-tile':
        this.createTileWithText(parsed.text ?? '');
        return true;

      default:
        return false;
    }
  },

  /**
   * Navigates to a board by opening/switching to its tab.
   */
  navigateToBoard(boardId: string) {
    const project = vaultStore.getData();
    if (!project) return;

    const board = project.boards.find((b) => b.id === boardId);
    if (!board) {
      uiStore.toast('Board not found', 'error', 2000);
      return;
    }

    tabStore.open(board.id, board.name, board.type, board.emoji);
  },

  /**
   * Opens a linked note in a Document tab, or says it isn't there: a note is
   * linked by its path, which a rename or a move outside Filo leaves behind.
   */
  openLinkedNote(path: string) {
    if (!vaultIndexStore.getMetadata(path)) {
      const name = path.split('/').pop() ?? path;
      uiStore.toast(`"${name}" isn't in the vault any more: it was renamed, moved or deleted.`, 'warning', 4000);
      return;
    }
    openNoteInDocumentTab(path);
  },

  /**
   * Navigates to a specific position on a board.
   */
  navigateToPosition(boardId: string, position: { x: number; y: number }) {
    // First navigate to the board
    this.navigateToBoard(boardId);

    // Then pan to the position (with a small delay to let the board load)
    requestAnimationFrame(() => {
      canvasStore.centerOn(position.x, position.y);
    });
  },

  /**
   * Creates a new text tile with the given content at viewport center.
   */
  createTileWithText(text: string) {
    if (!boardStore.current) return;

    const vp = canvasStore.viewportRect;
    const now = Date.now();

    const tile: Tile = {
      id: createId(),
      type: 'text',
      title: boardStore.getNextTileName(),
      position: {
        x: vp.left + vp.width / 2 - TILE_DEFAULTS.width / 2,
        y: vp.top + vp.height / 2 - TILE_DEFAULTS.height / 2,
      },
      size: { width: TILE_DEFAULTS.width, height: TILE_DEFAULTS.height },
      style: defaultTileStyleSnapshot(),
      locked: false,
      faded: false,
      tags: [],
      boardId: boardStore.current.id,
      content: text,
      createdAt: now,
      updatedAt: now,
    } as Tile;

    // Push through history so the auto-created tile from a filo:// link drop
    // is undoable.
    historyStore.execute(new AddTileCommand(tile));
  },
};
