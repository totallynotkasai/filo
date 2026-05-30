/**
 * Helpers that look up the *current* Default Board Font Size values
 * from project settings and return the right fields for a given
 * element / board-type context.
 *
 * Element factories call these at creation time and bake the returned
 * values into the new element's per-element style as
 * `fontSizeTitle` / `fontSizeBody` overrides. Changing a default in
 * Project Settings → General never retroactively updates an existing
 * element; the "Apply to all Existing Items" button in
 * GeneralSettings.svelte is the only path that rewrites overrides on
 * already-created elements.
 *
 * The lookups read directly from `vaultStore` so callers don't have to
 * thread project settings through every signature. When no project is
 * open (or `defaultBoardFontSize` is missing) the helpers return
 * `undefined` per field, which leaves the per-element style override
 * unset and the element falls through to its hardcoded CSS fallback.
 */
import { vaultStore } from '../../stores/vault.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import type { Board } from '../../schema/index';

function getDefaultBoardFontSize(): {
  tileTitle?: number;
  tileBody?: number;
  connectionLabel?: number;
  frameTitle?: number;
  kanbanColumnTitle?: number;
  kanbanCardTitle?: number;
  kanbanCardBody?: number;
  taskListTitle?: number;
  taskItem?: number;
} | undefined {
  return vaultStore.project?.settings?.general?.defaultBoardFontSize;
}

/** Mind Map tile title + body. */
export function defaultTileFontSizes(): { fontSizeTitle?: number; fontSizeBody?: number } {
  const bfs = getDefaultBoardFontSize();
  return {
    fontSizeTitle: bfs?.tileTitle,
    fontSizeBody: bfs?.tileBody,
  };
}

/** Mind Map connection label. */
export function defaultConnectionLabelFontSize(): number | undefined {
  return getDefaultBoardFontSize()?.connectionLabel;
}

/** Mind Map frame title. */
export function defaultFrameFontSize(): { fontSizeTitle?: number } {
  return { fontSizeTitle: getDefaultBoardFontSize()?.frameTitle };
}

/** Kanban column title. */
export function defaultKanbanColumnFontSize(): { fontSizeTitle?: number } {
  return { fontSizeTitle: getDefaultBoardFontSize()?.kanbanColumnTitle };
}

/** Kanban card title + body — applied to a card tile's per-tile style. */
export function defaultKanbanCardFontSizes(): { fontSizeTitle?: number; fontSizeBody?: number } {
  const bfs = getDefaultBoardFontSize();
  return {
    fontSizeTitle: bfs?.kanbanCardTitle,
    fontSizeBody: bfs?.kanbanCardBody,
  };
}

/** Task List task body (rendered as a row). */
export function defaultTaskFontSizes(): { fontSizeTitle?: number } {
  return { fontSizeTitle: getDefaultBoardFontSize()?.taskItem };
}

/** Task List board title (stored on `board.settings.titleFontSize`). */
export function defaultTaskListTitleFontSize(): number | undefined {
  return getDefaultBoardFontSize()?.taskListTitle;
}

/**
 * Looks up a board by id (via the boardCache) and returns the right
 * per-tile font-size defaults for the board it lives on. Used by the
 * generic Mind Map tile factory when it doesn't know the board type
 * statically.
 */
export function defaultFontSizesForBoard(boardId: string): { fontSizeTitle?: number; fontSizeBody?: number } {
  const cached = (boardCacheStore.cache[boardId] as { board?: Board } | undefined)?.board;
  switch (cached?.type) {
    case 'kanban':
      return defaultKanbanCardFontSizes();
    case 'tasklist':
      // Tasks render as a single body row; title and body both seed from `taskItem`.
      return { fontSizeTitle: getDefaultBoardFontSize()?.taskItem, fontSizeBody: getDefaultBoardFontSize()?.taskItem };
    case 'mindmap':
    default:
      return defaultTileFontSizes();
  }
}
