import type {
  KanbanBoard as KanbanBoardType,
  KanbanTilePlacement,
  TileDefinition,
} from '../../schema/index';
import { defaultTileStyleSnapshot } from '../../constants/defaults';
import { defaultKanbanCardFontSizes } from '../styles/defaultFontSizes';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { documentStore } from '../../stores/document.svelte';
import { historyStore } from '../../stores/history.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { AddCardCommand } from '../../commands/index';
import { createId } from '../utils/ids';
import { assembleMarkdownFile } from '../editor/markdownSync';
import { trackComponentWrite } from '../boards/boardSaver';
import { markHydrated } from '../vault/markdownFileWriter';
import { reportError } from '../utils/errorBus';
import { invokeOk } from '../utils/invokeOk';
import {
  interpolate,
  type TemplateContent,
  type TemplateRef,
} from '../templates/templateService';
import {
  fileNameSafe,
  getActiveContentFolder,
  nextUniqueMdPath as nextUniqueMdPathLib,
  titleFromRelPath as titleFromRelPathLib,
} from '../vault/conventionPaths';

export type KanbanNewTileType = 'text' | 'audio' | 'link' | 'template';

/**
 * Thin wrapper around the lib helper so callers don't pass the board cache
 * each time. Exported for reuse by Kanban-side tooling that needs the same
 * unique-filename guarantee (e.g. the saved-views picker on rename).
 */
export function nextUniqueMdPath(folder: string, baseName: string): string {
  return nextUniqueMdPathLib(boardCacheStore.cache, folder, baseName);
}

export function titleFromRelPath(relPath: string, folder: string): string {
  return titleFromRelPathLib(relPath, folder);
}

export function newCardFolder(board: KanbanBoardType | null): string {
  return getActiveContentFolder(board);
}

function buildBaseTileStyle() {
  const fs = defaultKanbanCardFontSizes();
  return {
    ...defaultTileStyleSnapshot(),
    ...(fs.fontSizeTitle !== undefined && { fontSizeTitle: fs.fontSizeTitle }),
    ...(fs.fontSizeBody !== undefined && { fontSizeBody: fs.fontSizeBody }),
  };
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

    // R5 — `TileDefinition` is a discriminated union, so each branch must
    // construct its own variant directly rather than mutating a partial
    // object through `as Record<string, unknown>` writes. The earlier
    // mutation pattern compiled only via casts and bypassed schema-level
    // validation of the per-type required fields.
    const baseDefFields = {
      id: tileId,
      title: tileTitle,
      style: buildBaseTileStyle(),
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    let def: TileDefinition;

    if (type === 'text') {
      const vaultRoot = vaultStore.path;
      const folder = newCardFolder(board);
      const baseName = fileNameSafe(tileTitle);
      const relPath = nextUniqueMdPath(folder, baseName);
      const finalTitle = titleFromRelPath(relPath, folder);
      const contentId = createId();
      let filePath: string | undefined;
      // No collision toast here: `tileTitle` is always a system default
      // ('New Card' / 'New Recording' / 'New Link') in this path, and a
      // "renamed because already exists" warning for an auto-generated
      // default is just noise — the user expects the suffix bump.
      if (vaultRoot) {
        try {
          await trackComponentWrite(vaultRoot, relPath, async () => {
            await invokeOk('vault:write-file-text', vaultRoot, relPath, '');
          });
          // Orphan-fm semantics: the file was just created with an empty body
          // and no frontmatter. Mark hydrated so the next gateway write (via
          // a TextTile that hasn't run its own hydrate yet, or a PropertiesPopup
          // opened on this card) can proceed without throwing.
          markHydrated(relPath, false);
          filePath = relPath;
          documentStore.loadDocument({
            docId: contentId,
            filename: relPath,
            title: finalTitle,
            body: '',
            htmlContent: '',
            richText: [],
          });
        } catch (err) {
          reportError(
            'kanban.seed-md',
            err,
            `Failed to create backing file for "${finalTitle}" — the card may not persist correctly`,
          );
        }
      }
      def = {
        ...baseDefFields,
        title: finalTitle,
        type: 'text',
        contentId,
        content: '',
        filePath,
      };
    } else if (type === 'audio') {
      def = {
        ...baseDefFields,
        type: 'audio',
        src: '',
        isRecording: false,
        isPlaying: false,
      };
    } else {
      // type === 'link'
      def = {
        ...baseDefFields,
        type: 'link',
        url: '',
      };
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
    const fmTitle = typeof content.frontmatter.title === 'string'
      ? content.frontmatter.title
      : undefined;
    const baseName = fileNameSafe(fmTitle ?? ref.name);
    const relPath = nextUniqueMdPath(folder, baseName);
    const finalTitle = titleFromRelPath(relPath, folder);

    // Interpolate `{{title}}` / `{{date}}` / `{{time}}` against the resolved
    // filename so the new card's body reflects its destination, not the
    // template's original placeholder. Frontmatter is forwarded verbatim
    // (minus `boardType`, which is a picker hint, not user content).
    const interpolatedBody = interpolate(content.bodyWithoutBoardBlock, { title: finalTitle });
    const { boardType: _bt, ...fmWithoutBoardType } = content.frontmatter as Record<string, unknown> & {
      boardType?: unknown;
    };
    void _bt;
    const contentId = createId();
    const fmWithDocId = { ...fmWithoutBoardType, id: contentId };
    const fileText = assembleMarkdownFile(fmWithDocId, interpolatedBody);

    try {
      await trackComponentWrite(vaultRoot, relPath, async () => {
        await invokeOk('vault:write-file-text', vaultRoot, relPath, fileText);
      });
      // Orphan-fm semantics: file just created on disk via the file-creating
      // channel. Subsequent edits flow through the gateway, which requires
      // hydration. Mark false since templates don't carry a BOM.
      markHydrated(relPath, false);
      await vaultStore.refreshTree();
    } catch (err) {
      reportError(
        'kanban.template-md',
        err,
        `Failed to create card from template "${ref.name}"`,
      );
      return;
    }

    const tileId = createId();
    const now = Date.now();
    // R5 — construct the typed text-tile def directly. The previous
    // partial-then-mutate pattern relied on `as TileDefinition` + casts
    // through `Record<string, unknown>` and bypassed schema-level
    // validation of `contentId` (required for text variants).
    const def: TileDefinition = {
      id: tileId,
      type: 'text',
      title: finalTitle,
      style: buildBaseTileStyle(),
      tags: [],
      createdAt: now,
      updatedAt: now,
      contentId,
      content: interpolatedBody,
      filePath: relPath,
    };

    documentStore.loadDocument({
      docId: contentId,
      filename: relPath,
      title: finalTitle,
      body: interpolatedBody,
      htmlContent: interpolatedBody,
      richText: [],
    });

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
