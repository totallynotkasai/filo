/**
 * "Make all Existing Items use the Default Font Sizes": clears every
 * element's own font size across every board in the active vault, so each
 * element follows the style cascade again (per-element > board > Global
 * Defaults > General → Default Board Font Size, `effectiveStyle.ts`).
 *
 * Triggered from `GeneralSettings.svelte` after a confirmation modal.
 * Operates directly on the boardCache (the in-memory snapshot of every
 * `.board.json`). Each touched board is flagged dirty so the debounced writer
 * flushes it to disk.
 *
 * Clearing, not stamping: a stamped size is a per-element override, the top
 * of the cascade, so it would hide every later change of a default and every
 * board or Global Defaults size.
 *
 * Not undoable: the operation is vault-wide whereas the history stacks are
 * per-board. The confirmation dialog is the safety net.
 */
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import type {
  Board,
  KanbanBoard,
  TaskListBoard,
  TileDefinition,
} from '../../schema/index';

type StyleBlock = Record<string, unknown>;

/** Removes `keys` from `block`; true when one was there. */
function dropSizes(block: StyleBlock | undefined, keys: readonly string[]): boolean {
  if (!block) return false;
  let dropped = false;
  for (const key of keys) {
    if (key in block) {
      delete block[key];
      dropped = true;
    }
  }
  return dropped;
}

const TITLE_AND_BODY = ['fontSizeTitle', 'fontSizeBody'] as const;
const TITLE = ['fontSizeTitle'] as const;

function styleOf(holder: unknown): StyleBlock | undefined {
  const style = (holder as { style?: unknown } | null | undefined)?.style;
  return typeof style === 'object' && style !== null ? (style as StyleBlock) : undefined;
}

/**
 * Walks every board in the project + boardCache and clears each element's
 * own font size. Returns how many elements and boards changed, for the toast.
 */
export function clearFontSizesOnAllExisting(): {
  boardsTouched: number;
  elementsTouched: number;
} {
  const project = vaultStore.project;
  if (!project) return { boardsTouched: 0, elementsTouched: 0 };

  let boardsTouched = 0;
  let elementsTouched = 0;

  const boardIds = new Set<string>();
  for (const b of project.boards ?? []) boardIds.add(b.id);
  for (const id of Object.keys(boardCacheStore.cache)) boardIds.add(id);

  for (const boardId of boardIds) {
    const cacheEntry = boardCacheStore.cache[boardId];
    const cached = (cacheEntry as { board?: Board } | undefined)?.board
      ?? project.boards?.find((b) => b.id === boardId);
    if (!cached) continue;

    let touched = 0;
    const count = (changed: boolean): void => {
      if (changed) touched++;
    };

    // Every board type keeps its note-backed tiles' definitions here; a card
    // or a task made before sizes stopped being copied carries them too.
    const tileDefs = (cacheEntry as { tileDefs?: Record<string, TileDefinition> } | undefined)?.tileDefs ?? {};
    for (const def of Object.values(tileDefs)) count(dropSizes(styleOf(def), TITLE_AND_BODY));

    if (cached.type === 'kanban') {
      for (const col of (cached as KanbanBoard).columns ?? []) {
        count(dropSizes(styleOf(col), TITLE));
        for (const placement of col.tilePlacements ?? []) count(dropSizes(styleOf(placement), TITLE_AND_BODY));
      }
    }

    if (cached.type === 'tasklist') {
      const tl = cached as TaskListBoard;
      count(dropSizes(tl.settings as StyleBlock | undefined, ['titleFontSize']));
      for (const task of tl.tasks ?? []) count(dropSizes(styleOf(task), TITLE_AND_BODY));
      for (const section of tl.sections ?? []) count(dropSizes(styleOf(section), TITLE));
    }

    // Frames and connections live inside .board.json (see BoardFileData), so
    // they're walked per owning board.
    if (cacheEntry) {
      for (const frame of cacheEntry.frames ?? []) count(dropSizes(styleOf(frame), TITLE));
      for (const conn of Object.values(cacheEntry.connections ?? {})) {
        const label = (conn as { label?: StyleBlock }).label;
        count(dropSizes(label, ['fontSize']));
      }
    }

    if (touched > 0) {
      elementsTouched += touched;
      boardsTouched++;
      boardCacheStore.markDirty(boardId);
    }
  }

  return { boardsTouched, elementsTouched };
}
