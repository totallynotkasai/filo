/**
 * What the shared `ElementStylePopup` edits, per element kind: Kanban cards
 * and columns, Task List tasks and sections. Each kind names its fields,
 * where a pick is written (the placement / column / section style block, so
 * the same `.md` on a Mind Map keeps its own style), how the live style is
 * read back at close, and the one undo command a popup session pushes.
 */
import { boardCacheStore } from '../../stores/boardCache.svelte';
import {
  UpdateKanbanCardStyleCommand,
  UpdateKanbanColumnStyleCommand,
  UpdateTaskItemStyleCommand,
  UpdateTaskSectionStyleCommand,
} from '../../commands/index';
import {
  liveKanbanCardStyle,
  liveKanbanColumnStyle,
  liveTaskSectionStyle,
  liveTaskStyle,
} from '../../commands/styleCommands';
import type { Command } from '../../commands/Command';
import type { BorderStyle, Shape } from '../../schema/styleEnums';

export type ElementStyleKind = 'kanbanCard' | 'kanbanColumn' | 'task' | 'taskSection';

/** Every field any kind's popup edits; each kind uses a subset. */
export interface ElementStyle {
  backgroundColor?: string;
  headerColor?: string;
  bodyColor?: string;
  shape?: Shape;
  /** Column only: drives the header accent bar and the card-count badge tint. */
  accent?: string;
  borderColor?: string;
  borderStyle?: BorderStyle;
  borderWidth?: number;
  shadowIntensity?: number;
  dynamicContrastText?: boolean;
  /** Column only: width in px. */
  width?: number;
  fontSizeTitle?: number;
  fontSizeBody?: number;
}

/** The optional rows; the rest (header, body, border, shadow, contrast, title size) are always shown. */
export interface ElementStyleFields {
  backgroundColor: boolean;
  shape: boolean;
  accent: boolean;
  width: boolean;
  fontSizeBody: boolean;
}

export interface ElementStyleTarget {
  title: string;
  /** Prefix of every control id (`<prefix>-border-style`, …). */
  idPrefix: string;
  /** Id suffix of the Title Font Size input. */
  titleFontIdSuffix: string;
  /** What the Shadow slider shows when the element has no override (and after Restore). */
  defaultShadow: number;
  fields: ElementStyleFields;
  /** Merge `patch` into the element's style; `null` clears the whole block. */
  write(boardId: string, id: string, patch: ElementStyle | null): void;
  /**
   * The element's style as it is in the board cache now, detached from the
   * store. `null` when the board is gone or is another type (no undo step
   * then); `{}` when the element or its style block is gone.
   */
  readLive(boardId: string, id: string): ElementStyle | null;
  command(boardId: string, id: string, before: ElementStyle, after: ElementStyle): Command;
}

export const ELEMENT_STYLE_TARGETS: Record<ElementStyleKind, ElementStyleTarget> = {
  kanbanCard: {
    title: 'Card Style',
    idPrefix: 'kcc',
    titleFontIdSuffix: 'font-title',
    defaultShadow: 0.2,
    fields: { backgroundColor: true, shape: true, accent: false, width: false, fontSizeBody: true },
    write: (boardId, id, patch) => boardCacheStore.updateKanbanCardPlacementStyle(boardId, id, patch),
    readLive: (boardId, id) => liveKanbanCardStyle(boardId, id) as ElementStyle | null,
    command: (boardId, id, before, after) => new UpdateKanbanCardStyleCommand(boardId, id, { ...before }, { ...after }),
  },
  kanbanColumn: {
    title: 'Column Style',
    idPrefix: 'kc',
    titleFontIdSuffix: 'font-size',
    defaultShadow: 0.3,
    fields: { backgroundColor: false, shape: false, accent: true, width: true, fontSizeBody: false },
    write: (boardId, id, patch) => boardCacheStore.updateKanbanColumnStyle(boardId, id, patch ? { ...patch } : null),
    readLive: (boardId, id) => liveKanbanColumnStyle(boardId, id) as ElementStyle | null,
    command: (boardId, id, before, after) => new UpdateKanbanColumnStyleCommand(boardId, id, { ...before }, { ...after }),
  },
  task: {
    title: 'Task Style',
    idPrefix: 'ti',
    titleFontIdSuffix: 'font-title',
    defaultShadow: 0.2,
    fields: { backgroundColor: false, shape: false, accent: false, width: false, fontSizeBody: true },
    write: (boardId, id, patch) => boardCacheStore.updateTaskPlacementStyle(boardId, id, patch),
    readLive: (boardId, id) => liveTaskStyle(boardId, id) as ElementStyle | null,
    command: (boardId, id, before, after) => new UpdateTaskItemStyleCommand(boardId, id, { ...before }, { ...after }),
  },
  taskSection: {
    title: 'Section Style',
    idPrefix: 'ts',
    titleFontIdSuffix: 'font-size',
    defaultShadow: 0.2,
    fields: { backgroundColor: false, shape: false, accent: false, width: false, fontSizeBody: false },
    write: (boardId, id, patch) => boardCacheStore.updateTaskSectionStyle(boardId, id, patch ? { ...patch } : null),
    readLive: (boardId, id) => liveTaskSectionStyle(boardId, id) as ElementStyle | null,
    command: (boardId, id, before, after) => new UpdateTaskSectionStyleCommand(boardId, id, { ...before }, { ...after }),
  },
};
