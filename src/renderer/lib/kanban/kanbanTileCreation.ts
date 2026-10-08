import type {
  KanbanBoard as KanbanBoardType,
  KanbanTilePlacement,
  TileDefinition,
} from '../../schema/index';
import { defaultTileStyleSnapshot } from '../../constants/defaults';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { AddCardCommand } from '../../commands/index';
import { createId } from '../utils/ids';
import { createNoteFile } from '../notes/createNote';
import { noteMadeForNewItem } from '../notes/madeForNewItems';
import { reportError } from '../utils/errorBus';
import type { TemplateContent, TemplateRef } from '../templates/templateService';
import { noteFromTemplate } from '../templates/templateNote';
import { getActiveContentFolder } from '../vault/conventionPaths';
import { editTitleWhenShown } from '../boards/newTileTitle';

export type KanbanNewTileType = 'text' | 'audio' | 'link' | 'template';

export function newCardFolder(board: KanbanBoardType | null): string {
  return getActiveContentFolder(board);
}

/** A new card's tile style. No font sizes: the card follows the card cascade. */
function buildBaseTileStyle() {
  return defaultTileStyleSnapshot();
}

export interface KanbanTileCreationDeps {
  getBoard: () => KanbanBoardType | null;
  getNewTileColumnId: () => string | null;
  setNewTileColumnId: (next: string | null) => void;
  setTemplatePickerColumnId: (next: string | null) => void;
  getTemplatePickerColumnId: () => string | null;
  tickAndPersist: () => void;
  announce: (message: string) => void;
  /**
   * Shows a card through the filters and the find bar until the returned
   * function is called (`KanbanFiltersAndSort.showWhileNamed`).
   */
  showWhileNamed: (tileId: string) => () => void;
  /** Whether the board draws the card now (`cardsOnScreen`). */
  isShown: (tileId: string) => boolean;
  /** The card's title as the board shows it, once it is on the board. */
  titleOf: (tileId: string) => string | undefined;
  /** Moves focus from inside the board to the board itself, before a card it is on leaves the screen. */
  keepFocusOnBoard: () => void;
}

export interface KanbanTileCreator {
  createTile(type: KanbanNewTileType): Promise<void>;
  createTileFromTemplate(
    ref: TemplateRef,
    content: TemplateContent,
    rawContent: string,
  ): Promise<void>;
}

/**
 * Tile-creation factory for KanbanBoard.
 *
 * Owns the side-effecting flow that combines a new `TileDefinition`,
 * optional `.md` seed on disk, document-store hydration, and the
 * AddCardCommand dispatch. Closes over reactive accessors so callers always
 * see the live board / picker state without capturing stale snapshots.
 *
 * The `'template'` branch of `createTile` short-circuits to the template
 * picker — `createTileFromTemplate` is then invoked from the picker's
 * `onSelect` callback once a template is chosen.
 */
export function makeKanbanTileCreator(deps: KanbanTileCreationDeps): KanbanTileCreator {
  const {
    getBoard,
    getNewTileColumnId,
    setNewTileColumnId,
    setTemplatePickerColumnId,
    getTemplatePickerColumnId,
    tickAndPersist,
    announce,
  } = deps;

  /**
   * Says where a new card went when the board doesn't draw it (a filter, the
   * find bar, a collapsed column), as the Task List does, instead of letting
   * it vanish.
   */
  function sayIfHidden(tileId: string, columnId: string): void {
    if (deps.isShown(tileId)) return;
    const column = getBoard()?.columns.find((c) => c.id === columnId);
    const title = deps.titleOf(tileId);
    const what = title ? `"${title}"` : 'A new card';
    const where = column ? ` to "${column.title}"` : '';
    const why = column?.collapsed ? ', which is collapsed.' : ', but the filters hide it.';
    uiStore.toast(`${what} was added${where}${why}`, 'info', 4000);
    deps.keepFocusOnBoard();
  }

  /**
   * A new card a filter would hide stays on screen while it is named; the
   * returned function lets it go once its title is done. A collapsed column
   * draws no card, so that one is said at once.
   */
  function showWhileNamed(tileId: string, columnId: string): () => void {
    if (getBoard()?.columns.find((c) => c.id === columnId)?.collapsed) {
      sayIfHidden(tileId, columnId);
      return () => {};
    }
    const release = deps.showWhileNamed(tileId);
    return () => {
      release();
      sayIfHidden(tileId, columnId);
    };
  }

  async function createTile(type: KanbanNewTileType): Promise<void> {
    const board = getBoard();
    const newTileColumnId = getNewTileColumnId();
    if (!board || !newTileColumnId) return;
    const targetColumnId = newTileColumnId;
    if (type === 'template') {
      // Hand off to the dedicated template picker. Keep the target column
      // around in `templatePickerColumnId` so the picker's onSelect can
      // route the new placement back to the right column without
      // re-prompting the user.
      setTemplatePickerColumnId(targetColumnId);
      setNewTileColumnId(null);
      return;
    }
    setNewTileColumnId(null);
    const now = Date.now();
    const tileId = createId();
    const baseTitle = type === 'text' ? 'New Card' : type === 'audio' ? 'New Recording' : 'New Link';
    const tileTitle = baseTitle;

    // `TileDefinition` is a discriminated union, so each branch constructs its
    // own variant directly rather than mutating a partial object through casts
    // (which would bypass type-checking of the per-type required fields).
    const baseDefFields = { id: tileId, style: buildBaseTileStyle(), createdAt: now, updatedAt: now };
    let def: TileDefinition;

    if (type === 'text') {
      const vaultRoot = vaultStore.path;
      // No backing file means no card: a text def must name its note.
      if (!vaultRoot) return;
      const folder = newCardFolder(board);
      let relPath: string;
      try {
        // Create-EXCLUSIVE: an existing off-board file with the same name is
        // never overwritten; the helper bumps to ` (n)`. The title stays the
        // one the user sees ('New Card'); only the filename is bumped, so no
        // "renamed because it exists" toast.
        let content: string;
        ({ relPath, content } = await createNoteFile({ vaultRoot, folder, title: tileTitle }));
        noteMadeForNewItem(relPath, content);
      } catch (err) {
        reportError('kanban.seed-md', err, `Failed to create a file for "${tileTitle}" — the card was not added`);
        return;
      }
      def = { ...baseDefFields, type: 'text', filePath: relPath };
    } else if (type === 'audio') {
      def = {
        ...baseDefFields,
        type: 'audio',
        title: tileTitle,
        src: '',
        isPlaying: false,
      };
    } else {
      // type === 'link'
      def = { ...baseDefFields, type: 'link', title: tileTitle, tags: [], url: '' };
    }

    const columns = board.columns;
    const placements = (columns.find((c) => c.id === targetColumnId)?.tilePlacements ?? []) as KanbanTilePlacement[];
    historyStore.execute(
      new AddCardCommand(board.id, targetColumnId, def, placements.length),
    );
    tickAndPersist();
    // Typing next names the card, instead of pressing New card again; a
    // filter that would hide it lets it through until the title is done.
    editTitleWhenShown(tileId, showWhileNamed(tileId, targetColumnId));
    const columnTitle = columns.find((c) => c.id === targetColumnId)?.title ?? 'column';
    announce(`Card added to ${columnTitle}`);
  }

  async function createTileFromTemplate(
    ref: TemplateRef,
    content: TemplateContent,
    _rawContent: string,
  ): Promise<void> {
    void _rawContent;
    const board = getBoard();
    if (!board) return;
    const targetColumnId = getTemplatePickerColumnId();
    setTemplatePickerColumnId(null);
    if (!targetColumnId) return;

    const vaultRoot = vaultStore.path;
    if (!vaultRoot) {
      uiStore.toast('Open a vault first to create a card from a template', 'info', 2000);
      return;
    }

    const folder = newCardFolder(board);
    // The same note every board makes from a template: the template's
    // `title:` (else its name), its frontmatter kept, `{{date}}`… filled in.
    const { title, frontmatter, body } = noteFromTemplate(content, ref.name);

    let relPath: string;
    try {
      let content: string;
      ({ relPath, content } = await createNoteFile({ vaultRoot, folder, title, frontmatter, body }));
      noteMadeForNewItem(relPath, content);
      await vaultStore.refreshTree();
    } catch (err) {
      reportError(
        'kanban.template-md',
        err,
        `Failed to create card from template "${ref.name}"`,
      );
      return;
    }

    const now = Date.now();
    const def: TileDefinition = {
      id: createId(),
      type: 'text',
      style: buildBaseTileStyle(),
      createdAt: now,
      updatedAt: now,
      filePath: relPath,
    };

    const columns = board.columns;
    const placements = (columns.find((c) => c.id === targetColumnId)?.tilePlacements ?? []) as KanbanTilePlacement[];
    // A refused add has said so already (the history store's toast).
    const added = await historyStore.execute(
      new AddCardCommand(board.id, targetColumnId, def, placements.length),
    ).then(() => true, () => false);
    tickAndPersist();
    if (!added) return;
    uiStore.toast(`Created card from template "${ref.name}"`, 'success', 1800);
    sayIfHidden(def.id, targetColumnId);
  }

  return { createTile, createTileFromTemplate };
}
