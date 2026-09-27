/**
 * Default-board factories — the single source of truth for the shape of a
 * freshly-created board of each type.
 *
 * Lives in its own file (separate from `boardRegistry.ts`) so non-component
 * callers — `boardCache.svelte.ts`, unit tests — can import the factories
 * without pulling the Svelte board components into their dep graph. The
 * component-bearing registry (`boardRegistry.ts`) re-uses these factories
 * verbatim.
 *
 * Decisions baked in here:
 *   - Kanban: `columns: []` (no starter "To Do / In Progress / Done").
 *   - Tasklist: one default `Task List` section + `collapsedSubtasks: []`.
 */

import type { BoardType } from '../../shared/types';
import type { Board, ProjectSettings } from '../schema/index';
import {
  MindMapBoardSchema,
  KanbanBoardSchema,
  TaskListBoardSchema,
  DocumentBoardSchema,
  defaultProjectSettings,
} from '../schema/index';
import { createId } from '../lib/utils/ids';
import { buildBoardSettingsFromGlobal } from '../lib/styles/buildBoardDefaults';

/**
 * A new board's `settings` block: no style of its own, so it follows the
 * Global Defaults (see `buildBoardDefaults.ts` for the rule). `settings`
 * supplies the one creation-time seed, the Task List title size; undefined
 * (called before a project is loaded, e.g. tests) uses the schema defaults.
 */
function snapshotSettings(
  type: BoardType,
  settings: ProjectSettings | Record<string, unknown> | undefined,
): Record<string, unknown> {
  return buildBoardSettingsFromGlobal(type, (settings ?? defaultProjectSettings()) as ProjectSettings);
}

/**
 * Factory accepts either the typed `ProjectSettings` (production callers
 * pass `vaultStore.project.settings`) or a loose `Record<string, unknown>`
 * (templates / tests that build a bag by hand). Either way, the body
 * routes through `snapshotSettings`, which downcasts to `ProjectSettings`
 * once at the boundary.
 */
export type BoardDefaultFactory = (
  id: string,
  name: string,
  settings?: ProjectSettings | Record<string, unknown>,
) => Board;

export const boardDefaults: Record<BoardType, BoardDefaultFactory> = {
  mindmap: (id, name, settings) => {
    const now = Date.now();
    return MindMapBoardSchema.parse({
      id,
      type: 'mindmap',
      name,
      emoji: '',
      createdAt: now,
      updatedAt: now,
      settings: snapshotSettings('mindmap', settings),
      viewport: { x: 0, y: 0, scale: 1 },
      placements: {},
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    });
  },

  kanban: (id, name, settings) => {
    const now = Date.now();
    return KanbanBoardSchema.parse({
      id,
      type: 'kanban',
      name,
      emoji: '',
      createdAt: now,
      updatedAt: now,
      settings: snapshotSettings('kanban', settings),
      columns: [],
    });
  },

  tasklist: (id, name, settings) => {
    const now = Date.now();
    return TaskListBoardSchema.parse({
      id,
      type: 'tasklist',
      name,
      emoji: '',
      createdAt: now,
      updatedAt: now,
      settings: snapshotSettings('tasklist', settings),
      tasks: [],
      sections: [
        { id: `sec_${createId()}`, title: 'Task List', position: 0, collapsed: false },
      ],
      collapsedSubtasks: [],
    });
  },

  document: (id, name, settings) => {
    const now = Date.now();
    return DocumentBoardSchema.parse({
      id,
      type: 'document',
      name,
      emoji: '',
      createdAt: now,
      updatedAt: now,
      settings: snapshotSettings('document', settings),
      filePath: '',
    });
  },
};
