/**
 * "Apply to all Existing Items" — retroactively bakes the current
 * Default Board Font Size values onto every existing element across
 * every board in the active vault.
 *
 * Triggered from `GeneralSettings.svelte` after a confirmation modal.
 * Operates directly on the boardCache (the in-memory snapshot of every
 * `.board.json`) and the project's connections/frames. Each touched
 * board is flagged dirty so the debounced writer flushes it to disk.
 *
 * The cascade in `effectiveStyle.ts` treats `fontSizeTitle`/
 * `fontSizeBody` per-element overrides as the highest-priority layer,
 * so writing them here wins over board-level or global defaults.
 *
 * Not undoable: the operation is project-wide whereas the history
 * stacks are per-board. The confirmation dialog is the safety net.
 */
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import type {
  Board,
  KanbanBoard,
  TaskListBoard,
  TileDefinition,
} from '../../schema/index';

interface FontDefaults {
  tileTitle?: number;
  tileBody?: number;
  connectionLabel?: number;
  frameTitle?: number;
  kanbanColumnTitle?: number;
  kanbanCardTitle?: number;
  kanbanCardBody?: number;
  taskListTitle?: number;
  taskItem?: number;
  taskItemBody?: number;
  taskSectionTitle?: number;
}

/**
 * Returns the current `defaultBoardFontSize` block from project
 * settings, or undefined if no project is open / the block isn't set.
 */
function currentDefaults(): FontDefaults | undefined {
  return vaultStore.project?.settings?.general?.defaultBoardFontSize;
}

function setIfNumber(target: Record<string, unknown>, key: string, value: number | undefined): boolean {
  if (typeof value !== 'number') return false;
  target[key] = value;
  return true;
}

/**
 * Walks every board in the project + boardCache and writes the current
 * Default Board Font Size values onto every element as a per-element
 * override. Returns a summary count of touched boards for toast UX.
 */
export function applyFontDefaultsToAllExisting(): {
  boardsTouched: number;
  elementsTouched: number;
} {
  const project = vaultStore.project;
  const defaults = currentDefaults();
  if (!project || !defaults) return { boardsTouched: 0, elementsTouched: 0 };

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

    let touched = false;

    if (cached.type === 'mindmap') {
      // Mind Map tiles live in project-level tile defs keyed by id.
      // Iterate every tile placement on this board's id and write the
      // tile def's style.
      const tileDefs = (cacheEntry as { tileDefs?: Record<string, TileDefinition> } | undefined)
        ?.tileDefs ?? {};
      for (const def of Object.values(tileDefs)) {
        const style = ((def as { style?: unknown }).style ??= {}) as Record<string, unknown>;
        const a = setIfNumber(style, 'fontSizeTitle', defaults.tileTitle);
        const b = setIfNumber(style, 'fontSizeBody', defaults.tileBody);
        if (a || b) {
          elementsTouched++;
          touched = true;
        }
      }
    }

    if (cached.type === 'kanban') {
      const kb = cached as KanbanBoard;
      for (const col of kb.columns ?? []) {
        const style = ((col as { style?: Record<string, unknown> }).style ??= {}) as Record<string, unknown>;
        if (setIfNumber(style, 'fontSizeTitle', defaults.kanbanColumnTitle)) {
          elementsTouched++;
          touched = true;
        }
      }
      // Kanban card style lives on the card's underlying TileDefinition (.style).
      const tileDefs = (cacheEntry as { tileDefs?: Record<string, TileDefinition> } | undefined)
        ?.tileDefs ?? {};
      for (const def of Object.values(tileDefs)) {
        const style = ((def as { style?: unknown }).style ??= {}) as Record<string, unknown>;
        const a = setIfNumber(style, 'fontSizeTitle', defaults.kanbanCardTitle);
        const b = setIfNumber(style, 'fontSizeBody', defaults.kanbanCardBody);
        if (a || b) {
          elementsTouched++;
          touched = true;
        }
      }
    }

    if (cached.type === 'tasklist') {
      const tl = cached as TaskListBoard;
      const settings = (tl as { settings?: Record<string, unknown> }).settings as Record<string, unknown> | undefined;
      if (settings && setIfNumber(settings, 'titleFontSize', defaults.taskListTitle)) {
        elementsTouched++;
        touched = true;
      }
      const tileDefs = (cacheEntry as { tileDefs?: Record<string, TileDefinition> } | undefined)
        ?.tileDefs ?? {};
      for (const def of Object.values(tileDefs)) {
        const style = ((def as { style?: unknown }).style ??= {}) as Record<string, unknown>;
        const a = setIfNumber(style, 'fontSizeTitle', defaults.taskItem);
        const b = setIfNumber(style, 'fontSizeBody', defaults.taskItemBody);
        if (a || b) {
          elementsTouched++;
          touched = true;
        }
      }
      // Task-list sections live on the board itself (cached.sections), not in
      // tileDefs. Each section's style.fontSizeTitle is the per-element layer
      // that the cascade reads when rendering a section header.
      for (const section of tl.sections ?? []) {
        const style = ((section as { style?: Record<string, unknown> }).style ??= {}) as Record<string, unknown>;
        if (setIfNumber(style, 'fontSizeTitle', defaults.taskSectionTitle)) {
          elementsTouched++;
          touched = true;
        }
      }
    }

    // Frames and connections also live inside .board.json (see
    // V7BoardFileData), so they're walked per-owning-board here and
    // counted into this board's `touched` flag. The previous version
    // walked `project.frames` / `project.connections` and called
    // `vaultStore.markMetaDirty()`, which only flushes `.filo/` configs
    // and silently dropped these edits at the next reload.
    if (cacheEntry) {
      for (const frame of cacheEntry.frames ?? []) {
        const style = ((frame as { style?: Record<string, unknown> }).style ??= {}) as Record<string, unknown>;
        if (setIfNumber(style, 'fontSizeTitle', defaults.frameTitle)) {
          elementsTouched++;
          touched = true;
        }
      }
      for (const conn of Object.values(cacheEntry.connections ?? {})) {
        const label = (conn as { label?: Record<string, unknown> }).label as Record<string, unknown> | undefined;
        if (label && setIfNumber(label, 'fontSize', defaults.connectionLabel)) {
          elementsTouched++;
          touched = true;
        }
      }
    }

    if (touched) {
      boardsTouched++;
      // Mark dirty so the debounced writer flushes the change.
      boardCacheStore.markDirty(boardId);
    }
  }

  return { boardsTouched, elementsTouched };
}
