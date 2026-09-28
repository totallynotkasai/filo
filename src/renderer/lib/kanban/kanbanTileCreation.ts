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
import { reportError } from '../utils/errorBus';
import {
  interpolate,
  type TemplateContent,
  type TemplateRef,
} from '../templates/templateService';
import { getActiveContentFolder } from '../vault/conventionPaths';

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
        ({ relPath } = await createNoteFile({ vaultRoot, folder, title: tileTitle }));
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
        isRecording: false,
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
    // The card's title is the template's `title:` when it has one, else the
    // template's name. Frontmatter is forwarded verbatim (minus `boardType`,
    // a picker hint, not user content); `{{title}}` interpolates the title.
    const title = typeof content.frontmatter.title === 'string' && content.frontmatter.title.trim()
      ? content.frontmatter.title
      : ref.name;
    const { boardType: _bt, ...templateFm } = content.frontmatter as Record<string, unknown> & {
      boardType?: unknown;
    };
    void _bt;
    const body = interpolate(content.bodyWithoutBoardBlock, { title });

    let relPath: string;
    try {
      ({ relPath } = await createNoteFile({ vaultRoot, folder, title, frontmatter: templateFm, body }));
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
    historyStore.execute(
      new AddCardCommand(board.id, targetColumnId, def, placements.length),
    );
    tickAndPersist();
    uiStore.toast(`Created card from template "${ref.name}"`, 'success', 1800);
  }

  return { createTile, createTileFromTemplate };
}
