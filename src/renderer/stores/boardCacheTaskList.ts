import type { TaskListBoard, TaskListSection, TaskPlacement, PartialTaskStyle, Tile, TileDefinition } from '../schema/index';
import { TileDefinitionSchema } from '../schema/index';
import type { CacheContext } from './boardCacheTypes';

type PartialTaskSectionStyle = Record<string, unknown>;

/**
 * Cache slice — Task List board mutations (placements, sections, saved views,
 * collapsed-subtask state). Section `position` is an absolute index into the
 * flat `tasks` array and is kept in sync with every insert/remove.
 *
 * Active-proxy reactivity contract (Phase 1.1 / 2.2 sweep)
 * --------------------------------------------------------
 * Every mutator below writes through the cache `$state` proxy. The active
 * `boardStore.current` is a separate proxy wrapping the same Board object;
 * Svelte 5 does not propagate writes between the two. The Task List host
 * repairs that with `tickAndPersist()` (shallow-clones `cached.board` so
 * the active proxy adopts a new top-level identity and re-fires its
 * derivations).
 *
 * **All mutators in this file rely on the caller to invoke `tickAndPersist()`
 * after the write.** The standard call paths are:
 * - `TaskListBoard.svelte` direct calls (collapsed-subtask toggle, locked
 *   toggle, section CRUD, structure persist) — caller ticks immediately.
 * - `commands/taskListCommands.ts` history commands — the dispatch site
 *   ticks immediately after `historyStore.execute`.
 * - `kanbanSavedViews.svelte.ts` and `taskListSavedViews.svelte.ts` saved-
 *   view writers tick on commit.
 *
 * Exception: the Task Section / Task Item Style popups (driven by
 * `updateTaskSectionStyle` / `updateTaskPlacementStyle`) write per-pick
 * without ticking and only push a single `Update*StyleCommand` on close.
 * They rely on Svelte's nested-leaf reactivity to repaint the rendered row
 * — the popup is mounted inside the board scope so the shared children
 * cross the proxy boundary correctly.
 */
export function makeTaskListSlice(ctx: CacheContext) {
  return {
    getFullTasksForBoard(boardId: string): Record<string, Tile> {
      const cached = ctx.getCache()[boardId];
      if (!cached || cached.board.type !== 'tasklist') return {};

      const tl = cached.board as TaskListBoard;
      const defs = cached.tileDefs ?? {};
      const result: Record<string, Tile> = {};

      for (const p of (tl.tasks ?? []) as TaskPlacement[]) {
        const def = defs[p.tileId];
        if (!def) continue;
        result[p.tileId] = {
          ...def,
          position: { x: 0, y: 0 },
          size: { width: 240, height: 160 },
          locked: p.locked === true,
          faded: false,
          boardId,
        } as Tile;
      }
      return result;
    },

    setTaskListSavedViews(
      boardId: string,
      savedViews: Array<{
        id: string;
        name: string;
        groupBy: string;
        sortBy: string;
        filterTags: string[];
        filterStatus: string | null;
        filterPriority: string | null;
        showCompleted: boolean;
        smartList: string;
      }>,
    ): void {
      const tl = ctx.tasklistBoardOrWarn(boardId, 'setTaskListSavedViews');
      if (!tl) return;
      const current = (tl.settings ?? {}) as Record<string, unknown>;
      (tl as Record<string, unknown>).settings = { ...current, savedViews };
      ctx.markDirty(boardId);
    },

    setTaskListCollapsedSubtasks(boardId: string, tileIds: string[]): void {
      const tl = ctx.tasklistBoardOrWarn(boardId, 'setTaskListCollapsedSubtasks');
      if (!tl) return;
      (tl as Record<string, unknown>).collapsedSubtasks = [...tileIds];
      ctx.markDirty(boardId);
    },

    persistAddTaskPlacement(
      boardId: string,
      def: TileDefinition,
      position: number,
      style?: PartialTaskStyle,
      targetSectionId?: string,
    ): void {
      const parsed = TileDefinitionSchema.safeParse(def);
      if (!parsed.success) {
        console.warn(
          '[boardCache] persistAddTaskPlacement: invalid TileDefinition; not persisted',
          { issues: parsed.error.issues, def },
        );
        return;
      }
      const validDef = parsed.data as TileDefinition;

      const resolvedBoardId =
        (ctx.getCache()[boardId]?.board.type === 'tasklist' ? boardId : '') ||
        ctx.findBoardIdForTask(validDef.id) ||
        '';
      const cached = ctx.getCache()[resolvedBoardId];
      if (!cached || cached.board.type !== 'tasklist') {
        ctx.warnUnresolved('tasklist:persistAddTaskPlacement', `tile:${validDef.id}`);
        return;
      }
      const tl = cached.board as TaskListBoard;

      const updatedDefs = { ...cached.tileDefs, [validDef.id]: validDef };
      const placements = [...((tl.tasks ?? []) as TaskPlacement[])];
      const oldLength = placements.length;
      const insertAt = Math.min(Math.max(position, 0), oldLength);
      const placement: TaskPlacement = { tileId: validDef.id, position };
      if (style) placement.style = style;
      placements.splice(insertAt, 0, placement);
      (tl as Record<string, unknown>).tasks = placements.map((p, i) => ({ ...p, position: i }));

      // Section positions are absolute indices into `tasks`.
      //
      // When `targetSectionId` is provided, the new task is going INTO that
      // section as the last member of its slice. Sections are stored sorted by
      // position with ties in array order (the LAST tied section owns the
      // slice), so the section start that shifts is decided by ARRAY ORDER
      // relative to the target — NOT a raw `position >= insertAt` compare.
      //
      // A numeric compare can't disambiguate sections that share a `position`
      // (multiple empty tail sections, or an empty section just before a
      // populated one): inserting into the LAST tied section would wrongly bump
      // its earlier empty siblings (which sit at the same position), and
      // inserting into an EARLIER tied section needs the later ones bumped.
      // Bumping every section AFTER the target in array order gets both right
      // (SEC-1). The target and everything before it keep their position.
      //
      // Legacy callers (no targetSectionId): fall back to the original
      // carve-out where any section whose start sits exactly at the
      // current tail stays put on an append. This keeps a single empty
      // tail section anchored when callers don't tell us which section
      // they meant.
      const sections = ((tl.sections ?? []) as Array<{ id: string; position: number }>);
      if (sections.length > 0) {
        if (targetSectionId) {
          const targetArrayIdx = sections.findIndex((s) => s.id === targetSectionId);
          (tl as Record<string, unknown>).sections = sections.map((s, arrayIdx) =>
            targetArrayIdx >= 0 && arrayIdx > targetArrayIdx
              ? { ...s, position: s.position + 1 }
              : s,
          );
        } else {
          const isAppend = insertAt >= oldLength;
          (tl as Record<string, unknown>).sections = sections.map((s) => {
            if (isAppend && s.position === oldLength) return s;
            return s.position >= insertAt ? { ...s, position: s.position + 1 } : s;
          });
        }
      }

      ctx.updateEntry(resolvedBoardId, { tileDefs: updatedDefs });
      ctx.markDirty(resolvedBoardId);
    },

    removeTaskPlacement(boardId: string, tileId: string): void {
      const resolvedBoardId =
        (ctx.getCache()[boardId]?.board.type === 'tasklist' ? boardId : '') ||
        ctx.findBoardIdForTask(tileId) ||
        '';
      const cached = ctx.getCache()[resolvedBoardId];
      if (!cached || cached.board.type !== 'tasklist') {
        ctx.warnUnresolved('tasklist:removeTaskPlacement', `tile:${tileId}`);
        return;
      }
      const tl = cached.board as TaskListBoard;

      const original = ((tl.tasks ?? []) as TaskPlacement[]);
      const removedAt = original.findIndex((p) => p.tileId === tileId);
      if (removedAt < 0) return;
      const placements = original.filter((p) => p.tileId !== tileId);
      (tl as Record<string, unknown>).tasks = placements.map((p, i) => ({ ...p, position: i }));

      // Mirror the insert path: any section whose start sits above the removed
      // task's index drifts down one slot to stay anchored to the same boundary.
      const sections = ((tl.sections ?? []) as Array<{ position: number }>);
      if (sections.length > 0) {
        (tl as Record<string, unknown>).sections = sections.map((s) =>
          s.position > removedAt ? { ...s, position: s.position - 1 } : s,
        );
      }

      const { [tileId]: _removed, ...restDefs } = cached.tileDefs;
      void _removed;
      ctx.updateEntry(resolvedBoardId, { tileDefs: restDefs });
      ctx.markDirty(resolvedBoardId);
    },

    reorderTaskPlacement(boardId: string, tileId: string, targetPosition: number): void {
      const tl = ctx.tasklistBoardOrWarn(boardId, 'reorderTaskPlacement');
      if (!tl) return;

      // DRAG-5 — this helper renumbers `tasks` but does NOT adjust section
      // `position` boundaries, so on a sectioned board it would silently desync
      // the section slices from the rows. It has no production caller today
      // (drag + keyboard reorders route through moveTaskBlock /
      // ReorderTaskWithinSectionCommand, which DO maintain section ranges).
      // No-op-with-warn rather than corrupt a sectioned board if a future caller
      // wires it in; the unsectioned path it was written for is unaffected.
      if (((tl.sections ?? []) as TaskListSection[]).length > 0) {
        console.warn(
          '[boardCache] reorderTaskPlacement: refusing on a sectioned board — use moveTaskBlock / ReorderTaskWithinSectionCommand',
        );
        return;
      }

      const placements = [...((tl.tasks ?? []) as TaskPlacement[])];
      const fromIdx = placements.findIndex((p) => p.tileId === tileId);
      if (fromIdx < 0) return;
      const [moved] = placements.splice(fromIdx, 1);
      if (!moved) return; // fromIdx >= 0; splice yields one element
      const insertAt = Math.min(Math.max(targetPosition, 0), placements.length);
      placements.splice(insertAt, 0, moved);
      (tl as Record<string, unknown>).tasks = placements.map((p, i) => ({ ...p, position: i }));
      ctx.markDirty(boardId);
    },

    setTaskPlacementLocked(boardId: string, tileId: string, locked: boolean): void {
      const tl = ctx.tasklistBoardOrWarn(boardId, 'setTaskPlacementLocked');
      if (!tl) return;
      const placements = [...((tl.tasks ?? []) as TaskPlacement[])];
      const idx = placements.findIndex((p) => p.tileId === tileId);
      if (idx < 0) return;
      const current = placements[idx];
      if (!current) return; // idx >= 0 from findIndex; narrow for the type-checker
      const next: TaskPlacement = { ...current };
      if (locked) next.locked = true;
      else delete next.locked;
      placements[idx] = next;
      (tl as Record<string, unknown>).tasks = placements;
      ctx.markDirty(boardId);
    },

    updateTaskPlacementStyle(
      boardId: string,
      tileId: string,
      style: PartialTaskStyle | null,
    ): void {
      const tl = ctx.tasklistBoardOrWarn(boardId, 'updateTaskPlacementStyle');
      if (!tl) return;
      const placements = [...((tl.tasks ?? []) as TaskPlacement[])];
      const idx = placements.findIndex((p) => p.tileId === tileId);
      if (idx < 0) return;
      const current = placements[idx];
      if (!current) return; // idx >= 0 from findIndex; narrow for the type-checker
      const next: TaskPlacement = { ...current };
      if (!style || Object.keys(style).length === 0) {
        delete next.style;
      } else {
        next.style = { ...(current.style ?? {}), ...style };
      }
      placements[idx] = next;
      (tl as Record<string, unknown>).tasks = placements;
      ctx.markDirty(boardId);
    },

    /**
     * Merge a partial style override onto a Task List section. Pass `null`
     * or an empty object to clear the override entirely.
     */
    updateTaskSectionStyle(
      boardId: string,
      sectionId: string,
      style: PartialTaskSectionStyle | null,
    ): void {
      const tl = ctx.tasklistBoardOrWarn(boardId, 'updateTaskSectionStyle');
      if (!tl) return;
      const sections = ((tl.sections ?? []) as TaskListSection[]).map((s) => {
        if (s.id !== sectionId) return s;
        const prevStyle = (s as Record<string, unknown>).style as
          | Record<string, unknown>
          | undefined;
        const next: Record<string, unknown> = { ...s };
        if (!style || Object.keys(style).length === 0) {
          delete next.style;
        } else {
          next.style = { ...(prevStyle ?? {}), ...style };
        }
        return next as TaskListSection;
      });
      (tl as Record<string, unknown>).sections = sections;
      ctx.markDirty(boardId);
    },

    persistTaskListStructure(
      boardId: string,
      sections: { id: string; title: string; position: number; collapsed: boolean }[],
      tasks?: TaskPlacement[],
    ): void {
      const tl = ctx.tasklistBoardOrWarn(boardId, 'persistTaskListStructure');
      if (!tl) return;
      if (tasks) {
        (tl as Record<string, unknown>).tasks = tasks.map((p, i) => ({ ...p, position: i }));
      }
      const taskCount = ((tl.tasks ?? []) as TaskPlacement[]).length;
      // Section positions are absolute indices into `tasks`, partitioning it
      // into contiguous [position, nextPosition) slices. Among sections tied at
      // the same position the LAST in array order owns the slice and the earlier
      // ones are empty (see sectionMath.sectionIdForPlacementIndex /
      // taskListViewModel.sectionedView) — the schema's documented empty-section
      // form ("Empty sections are representable (two consecutive section
      // positions)" — schema/board.ts).
      //
      // Normalisation is a stable sort + a clamp into [0, taskCount].
      //   - SEC-2: never emit `position > taskCount`. Such a position is not a
      //     valid index into `tasks`; it can't own anything AND it silently
      //     misroutes a later add-to-section into an earlier neighbour (SEC-1).
      //     Trailing empty sections therefore PIN at taskCount (they used to be
      //     bumped to taskCount+1, taskCount+2, … — the invalid representation).
      //   - In-range ties are preserved exactly (bumping one would shift the
      //     next section's start past its first task, silently stealing it — the
      //     cross-section-drag corruption).
      //   - SEC-4: the sort is stable, so the caller's array order is kept
      //     deterministically. Callers must list empty ties BEFORE the populated
      //     owner; the clamp + min() are monotonic so the array stays sorted by
      //     position (a non-decreasing run can only tie, never invert).
      const normalised = sections
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((s) => ({ ...s, position: Math.max(0, Math.min(s.position, taskCount)) }));
      (tl as Record<string, unknown>).sections = normalised;
      ctx.markDirty(boardId);
    },
  };
}
