import type { Component } from 'svelte';
import type { BoardType } from '../../shared/types';
import type { Board } from '../schema/index';
import { boardDefaults, type BoardDefaultFactory } from './boardDefaults';

/**
 * A lazily-loaded board component module. A static import would pull TipTap +
 * lowlight + markdown-tools (~4.5 MB) into the entry chunk, parsed before the
 * no-vault Home screen is interactive. Boards only mount once a vault is open,
 * so the import is deferred to first board render.
 */
export type BoardComponentLoader = () => Promise<{
  default: Component<Record<string, unknown>>;
}>;

/**
 * Metadata entry for a board type in the registry.
 */
export interface BoardRegistryEntry {
  /** The board type identifier. */
  type: BoardType;
  /** Human-readable display name. */
  name: string;
  /** Lazily imports the Svelte component used to render this board. */
  component: BoardComponentLoader;
  /** Whether this board uses the infinite canvas (pan/zoom). */
  usesCanvas: boolean;
  /**
   * Factory function to create a default board instance. The four
   * factories live in `./boardDefaults` so non-component code paths (the
   * board-cache store, unit tests) can import them without dragging Svelte
   * components into their dep graph.
   */
  createDefault: BoardDefaultFactory;
}

/**
 * Registry of all board types with their metadata, lazy component loaders, and
 * factory functions. The factories are imported from `./boardDefaults` — the
 * single source of truth for the shape of a freshly-created board.
 */
export const boardRegistry: Record<BoardType, BoardRegistryEntry> = {
  mindmap: {
    type: 'mindmap',
    name: 'Mind Map',
    component: () =>
      import('../components/boards/MindMapBoard.svelte').then((m) => ({
        default: m.default as Component<Record<string, unknown>>,
      })),
    usesCanvas: true,
    createDefault: boardDefaults.mindmap,
  },

  kanban: {
    type: 'kanban',
    name: 'Kanban',
    component: () =>
      import('../components/boards/KanbanBoard.svelte').then((m) => ({
        default: m.default as Component<Record<string, unknown>>,
      })),
    usesCanvas: false,
    createDefault: boardDefaults.kanban,
  },

  tasklist: {
    type: 'tasklist',
    name: 'Task List',
    component: () =>
      import('../components/boards/TaskListBoard.svelte').then((m) => ({
        default: m.default as Component<Record<string, unknown>>,
      })),
    usesCanvas: false,
    createDefault: boardDefaults.tasklist,
  },

  document: {
    type: 'document',
    name: 'Document',
    component: () =>
      import('../components/boards/DocumentEditor.svelte').then((m) => ({
        default: m.default as Component<Record<string, unknown>>,
      })),
    usesCanvas: false,
    createDefault: boardDefaults.document,
  },
};

// Re-export `Board` so existing callers of `boardRegistry` that destructure
// the type stay backward-compatible.
export type { Board };
