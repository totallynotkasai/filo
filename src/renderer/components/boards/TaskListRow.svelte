<script lang="ts">
  /**
   * TaskListRow — thin wrapper around <TaskItem> for the Task List board.
   *
   * The wrapper layer exists because:
   *   - the dndzone keys off `.tasklist-row-wrap`, so the surrounding div
   *     must carry `data-task-id` and the wrap class;
   *   - `<TaskItem>` receives a flat task contract (`task: Tile` + 20+
   *     callbacks), but the host orchestrator's per-row data is shaped as
   *     a `TaskRow` plus a depth + section context — this component closes
   *     that gap.
   *
   * Bundle props by purpose:
   *   - `viewModel` carries the read-only derived row context
   *     (childrenByParent for subtask presence, rows for depth lookups,
   *     availableSectionsForMove for the "Move to section…" menu);
   *   - `controllers` carries the runtime controllers whose state this row
   *     needs to read mid-render (drag controller's active drag, multi-
   *     select's anchor set, plus the field writers / deleter / creator);
   *   - `callbacks` carries the small handful of host-level actions that
   *     don't fit either bundle (rename, properties popup, tag editor,
   *     openTask, toggleLock, moveToSection, toggleSubtaskCollapsed).
   *
   * Three primitives stay un-bundled (`row`, `depth`, `sectionId`) because
   * they're the per-render args — there's one row per call, and the
   * bundles are reused across rows.
   */
  import TaskItem from './TaskItem.svelte';
  import { ACCENT_COLOR } from '../../constants/defaults';
  import {
    getTaskDepth,
    type RowLike,
  } from '../../lib/tasklist/blockMove';
  import { sectionIdForPlacementIndex } from '../../lib/tasklist/sectionMath';
  import type { TaskRow } from '../../lib/tasks/taskListModel';
  import type { Priority } from '../../lib/tasks/frontmatterReaders';
  import type { ResolvedTaskStyle } from '../../lib/styles/effectiveStyle';
  import type {
    TaskListRowBoardCtx,
    TaskListRowCallbacks,
    TaskListRowControllers,
    TaskListRowViewModel,
  } from './taskListRowProps';

  let {
    row,
    depth,
    sectionId,
    collapsedSubtasks,
    accentColor = ACCENT_COLOR,
    resolveTaskStyle,
    viewModel,
    controllers,
    callbacks,
    boardCtx,
  }: {
    row: TaskRow;
    depth: number;
    sectionId: string;
    collapsedSubtasks: Set<string>;
    accentColor?: string;
    /** Per-row cascade resolver supplied by <TaskListBoard>. Called with
     *  this row's `placement.style` so per-task overrides (written by
     *  <TaskItemStylePopup>) win over the board / global task defaults. */
    resolveTaskStyle: (placementStyle?: Record<string, unknown> | null) => ResolvedTaskStyle;
    viewModel: TaskListRowViewModel;
    controllers: TaskListRowControllers;
    callbacks: TaskListRowCallbacks;
    boardCtx: TaskListRowBoardCtx;
  } = $props();

  // Resolve THIS row's effective style against its placement.style. The
  // popup writes per-task overrides into `placement.style`, so reading
  // placement.style here is the only path that lets the popup edits reach
  // <TaskItem>.
  const taskStyle = $derived(
    resolveTaskStyle(row.placement.style as Record<string, unknown> | null | undefined),
  );

  // Derived: number of visible direct children (for the chevron + count badge).
  // Reads `viewModel.childrenByParent` reactively — its source is the host's
  // TaskListViewModel `$derived` chain, so the lookup re-runs when subtask
  // structure changes.
  let kids = $derived(viewModel.childrenByParent.get(row.tile.id) ?? []);
  let isSubtaskCollapsed = $derived(collapsedSubtasks.has(row.tile.id));
  let isSelected = $derived(controllers.multiSelect.selectedTaskIds.has(row.tile.id));
  // `currentSectionId` is the persisted section this row lives in. Distinct
  // from the `sectionId` prop (which is the *zone* id used by the dndzone
  // mirror: the leading sentinel uses `__leading__`). The TaskItem's
  // "Move to section…" filter wants the persisted id.
  let currentSectionId = $derived(
    sectionIdForPlacementIndex(
      boardCtx.sections,
      boardCtx.placements.findIndex((p) => p.tileId === row.tile.id),
    ),
  );
  let canAddSubtask = $derived(getTaskDepth(viewModel.rows as RowLike[], row.tile.id) < 2);
  let isDragging = $derived(
    controllers.drag.dragTileId === row.tile.id
      || (controllers.drag.dragTileId !== null
          && controllers.drag.dragBlockIds.includes(row.tile.id)),
  );
  let dragCount = $derived(
    controllers.drag.dragTileId === row.tile.id
      && controllers.drag.dragBlockIds.length > 1
      ? controllers.drag.dragBlockIds.length - 1
      : 0,
  );
</script>

<div
  class="tasklist-row-wrap"
  data-task-id={row.tile.id}
>
  <TaskItem
    tile={row.tile}
    completed={row.completed}
    priority={row.priority}
    dueDate={row.dueDate}
    dueTime={row.dueTime}
    startDate={row.startDate}
    recurrence={row.recurrence}
    selected={isSelected}
    selectionSize={controllers.multiSelect.selectedTaskIds.size}
    {accentColor}
    {taskStyle}
    {depth}
    childCount={kids.length}
    childrenCollapsed={isSubtaskCollapsed}
    onToggleChildrenCollapsed={() => callbacks.onToggleSubtaskCollapsed(row.tile.id)}
    onToggleComplete={() => controllers.writers.toggleCompleted(row)}
    onCyclePriority={() => controllers.writers.cyclePriority(row)}
    onSetPriority={(p: Priority) =>
      controllers.writers.updateRowField(row, { priority: p === 'none' ? '' : p })}
    onSetDueDate={(d: string) => controllers.writers.setDueDate(row, d)}
    onSetDueTime={(t: string) => controllers.writers.setDueTime(row, t)}
    onSetStartDate={(d: string) => controllers.writers.setStartDate(row, d)}
    onSetRecurrence={(r: string) => controllers.writers.setRecurrence(row, r)}
    onSetNotes={(b: string) => controllers.writers.setNotesBody(row, b)}
    onRename={(t: string) => callbacks.onRenameTask(row, t)}
    onDelete={(anchor?: { x: number; y: number }) => callbacks.onDeleteTask(row.tile.id, anchor)}
    onDeleteWithFile={() => callbacks.onDeleteWithFile(row.tile.id)}
    onOpen={() => callbacks.onOpenTask(row.tile)}
    onAddSubtask={() => callbacks.onAddSubtask(row.tile.id)}
    {canAddSubtask}
    onToggleLocked={() => callbacks.onToggleLocked(row.tile.id)}
    onSelect={(mods: { shift: boolean; ctrl: boolean }) =>
      controllers.multiSelect.handleRowSelect(row.tile.id, mods)}
    availableSections={viewModel.availableSectionsForMove}
    {currentSectionId}
    onMoveToSection={(sid: string) => callbacks.onMoveToSection(row.tile.id, sid)}
    onDragHandlePointerDown={(e: PointerEvent) => {
      // Arm the dndzones for one gesture. Passing this row's tile id lets
      // the controller snapshot `dragBlockIds` from the current multi-select
      // RIGHT NOW (kanban-style) — snapshotting later, at the first
      // `consider` event, races with selection mutations and silently
      // demotes multi-drags to single-row drags. The handle starts the
      // drag on the *next* pointermove; svelte-dnd-action re-evaluates
      // `dragDisabled` on every tick so the flip propagates without the
      // need to replay the missed pointerdown.
      controllers.drag.armRow(sectionId, row.tile.id, e.clientX, e.clientY);
    }}
    onShowProperties={() => callbacks.onShowProperties(row.tile.id)}
    onEditTags={(anchor: { x: number; y: number }) =>
      callbacks.onEditTags(row.tile.id, anchor)}
    {isDragging}
    {dragCount}
  />
</div>

<style>
  /* Row wrapper sits inside the per-section dndzone. svelte-dnd-action
     handles the where-will-it-land cue via FLIP-shifting sibling rows out
     of the way; we no longer need above/below indicator strokes. The
     indent gesture is detected by the IndentTracker sidecar at drop time
     and surfaces via toast + screen-reader announcement (no live
     indicator in V1). */
  .tasklist-row-wrap {
    position: relative;
    border-radius: 4px;
  }
</style>
