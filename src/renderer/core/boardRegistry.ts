import type { Component } from 'svelte';
import type { BoardType } from '../../shared/types';
import MindMapBoard from '../components/boards/MindMapBoard.svelte';
import KanbanBoard from '../components/boards/KanbanBoard.svelte';
import TaskListBoard from '../components/boards/TaskListBoard.svelte';
import DocumentEditor from '../components/boards/DocumentEditor.svelte';
import type { Board } from '../schema/index';
import { boardDefaults, type BoardDefaultFactory } from './boardDefaults';

/**
 * Metadata entry for a board type in the registry.
 */
export interface BoardRegistryEntry {
  /** The board type identifier. */
  type: BoardType;
  /** Human-readable display name. */
  name: string;
  /** The Svelte component used to render this board. */
  component: Component<Record<string, unknown>>;
  /** Whether this board uses the infinite canvas (pan/zoom). */
  usesCanvas: boolean;
  /**
   * Factory function to create a default board instance. Phase 5 — the four
   * factories live in `./boardDefaults` so non-component code paths (the
   * board-cache store, unit tests) can import them without dragging Svelte
   * components into their dep graph.
   */
  createDefault: BoardDefaultFactory;
}

/**
 * Registry of all board types with their metadata, components, and factory
 * functions. The factories are imported from `./boardDefaults` — the single
 * source of truth for the shape of a freshly-created board.
 */
export const boardRegistry: Record<BoardType, BoardRegistryEntry> = {
  mindmap: {
    type: 'mindmap',
    name: 'Mind Map',
    component: MindMapBoard as Component<Record<string, unknown>>,
    usesCanvas: true,
    createDefault: boardDefaults.mindmap,
  },

  kanban: {
    type: 'kanban',
    name: 'Kanban',
    component: KanbanBoard as Component<Record<string, unknown>>,
    usesCanvas: false,
    createDefault: boardDefaults.kanban,
  },

  tasklist: {
    type: 'tasklist',
    name: 'Task List',
    component: TaskListBoard as Component<Record<string, unknown>>,
    usesCanvas: false,
    createDefault: boardDefaults.tasklist,
  },

  document: {
    type: 'document',
    name: 'Document',
    component: DocumentEditor as Component<Record<string, unknown>>,
    usesCanvas: false,
    createDefault: boardDefaults.document,
  },
};

// Re-export `Board` so existing callers of `boardRegistry` that destructure
// the type stay backward-compatible.
export type { Board };
