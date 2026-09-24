/**
 * Prop bundles for <TaskListRow> (and <TaskListSection>, which forwards
 * them to each rendered row). Lives next to the component as a plain `.ts`
 * file because Svelte's compiler can't re-export TypeScript interfaces
 * across `.svelte` boundaries — splitting the types into a sibling module
 * keeps the host import block tidy and avoids the `type-only-from-svelte`
 * footgun.
 *
 * Also holds the section-level prop bundles
 * (`TaskListSectionControllers`, `TaskListSectionCallbacks`,
 * `SectionView`-keyed view) used by the extracted <TaskListSection>.
 */
import type { TaskRow } from '../../lib/tasks/taskListModel';
import type { SectionView } from '../../lib/tasklist/taskListViewModel.svelte';
import type { DndEvent } from 'svelte-dnd-action';
import type {
  TaskListSection,
  TaskPlacement,
  Tile,
} from '../../schema/index';

/**
 * Read-only view-model accessors. Each field is read live (the host's
 * TaskListViewModel exposes them as `$derived` so reactivity flows through
 * every read site without the row taking a direct store import).
 */
export interface TaskListRowViewModel {
  rows: TaskRow[];
  childrenByParent: Map<string, TaskRow[]>;
  availableSectionsForMove: Array<{ id: string; title: string }>;
}

/**
 * Reactive controllers + writers the row needs to read or invoke
 * mid-render. Field setters from `frontmatterWriter` are passed through
 * directly so each row binds its TaskItem callbacks 1:1 without an extra
 * indirection layer in the row component.
 */
export interface TaskListRowControllers {
  /** Live drag state — drives the row's `isDragging` highlight + the
   *  multi-row drag-count badge. `armRow` is invoked on drag-handle
   *  pointerdown to arm the section's dndzone for one gesture. */
  drag: {
    dragTileId: string | null;
    dragBlockIds: string[];
    armRow: (sectionId: string, tileId: string, x: number, y: number) => void;
  };
  /** Multi-select state — `selectedTaskIds` for the selected highlight,
   *  `handleRowSelect` for click handling with shift/ctrl modifiers. */
  multiSelect: {
    selectedTaskIds: Set<string>;
    handleRowSelect: (
      tileId: string,
      mods: { shift: boolean; ctrl: boolean },
    ) => void;
  };
  /** Debounced frontmatter writers for the field-level row callbacks. */
  writers: {
    toggleCompleted: (row: TaskRow) => void;
    cyclePriority: (row: TaskRow) => void;
    updateRowField: (row: TaskRow, patch: Record<string, unknown>) => void;
    setDueDate: (row: TaskRow, iso: string) => void;
    setDueTime: (row: TaskRow, hhmm: string) => void;
    setStartDate: (row: TaskRow, iso: string) => void;
    setRecurrence: (row: TaskRow, rule: string) => void;
    setNotesBody: (row: TaskRow, body: string) => void;
  };
}

/**
 * Host-level callbacks that don't fit a controller bundle. Each is a
 * thin one-liner in TaskListBoard.svelte's `<script>`.
 */
export interface TaskListRowCallbacks {
  onRenameTask: (row: TaskRow, newTitle: string) => void;
  onDeleteTask: (tileId: string, anchor?: { x: number; y: number }) => void;
  /** Opt-in "delete task and its backing .md file" path. */
  onDeleteWithFile: (tileId: string) => void;
  onOpenTask: (tile: Tile) => void;
  onAddSubtask: (tileId: string) => void;
  onToggleLocked: (tileId: string) => void;
  onMoveToSection: (tileId: string, sectionId: string) => void;
  onToggleSubtaskCollapsed: (tileId: string) => void;
  onShowProperties: (tileId: string) => void;
  onEditTags: (tileId: string, anchor: { x: number; y: number }) => void;
}

/**
 * Persisted board-level context the row needs for `currentSectionId`
 * lookup. Bundled because both fields are read at once during the lookup
 * and reading them via the same prop keeps the reactivity surface tight.
 */
export interface TaskListRowBoardCtx {
  placements: TaskPlacement[];
  sections: TaskListSection[];
}

// ---------------------------------------------------------------------------
// Section-level prop bundles
// ---------------------------------------------------------------------------

/**
 * O(1) lookup from `tileId` → row + depth. Built by the host in a
 * `$derived` over `flatSections`; passed through to the section so its
 * inner dndzone `{#each rowItems}` can resolve each item without re-walking
 * the row tree.
 */
export interface FlatRowEntry {
  row: TaskRow;
  depth: number;
}

/**
 * Drag-controller surface the section needs. Wider than the row's
 * `drag` bundle — the section drives the per-row dndzone (items mirror,
 * disabled-gate, transform / clear-stale actions, consider / finalize
 * handlers) in addition to the row-level fields. Structurally compatible
 * with `TaskDragController` so the host passes the same instance through.
 */
export interface TaskListSectionDragController {
  // Forwarded row-level fields (must stay assignable to
  // `TaskListRowControllers['drag']`).
  dragTileId: string | null;
  dragBlockIds: string[];
  armRow: (sectionId: string, tileId: string, x: number, y: number) => void;

  // Section-level fields driving the per-section row dndzone.
  rowItemsBySection: Record<string, { id: string }[]>;
  rowDragDisabledBySection: Record<string, boolean>;
  transformDraggedRow: (el?: HTMLElement) => void;
  clearStaleDndRowStyles: (
    node: HTMLElement,
    trigger: unknown,
  ) => { update(t: unknown): void; destroy(): void };
  onConsiderRows: (
    sectionId: string,
    e: CustomEvent<DndEvent<{ id: string }>>,
  ) => void;
  onFinalizeRows: (
    sectionId: string,
    e: CustomEvent<DndEvent<{ id: string }>>,
  ) => void;
}

/**
 * Controllers + writers the section needs. `drag` widens the row's drag
 * bundle (see {@link TaskListSectionDragController}); `multiSelect` and
 * `writers` are reused verbatim from {@link TaskListRowControllers} and
 * forwarded to each rendered <TaskListRow>.
 */
export interface TaskListSectionControllers {
  drag: TaskListSectionDragController;
  multiSelect: TaskListRowControllers['multiSelect'];
  writers: TaskListRowControllers['writers'];
}

/**
 * Section-level host callbacks. Each is a closure over host state — the
 * section forwards args through without inspecting them. Row-level
 * callbacks live in {@link TaskListRowCallbacks} and are passed through a
 * sibling `rowCallbacks` prop.
 */
export interface TaskListSectionCallbacks {
  toggleSectionCollapsed: (sectionId: string) => void;
  commitSectionRename: () => void;
  cancelSectionRename: () => void;
  openSectionContextMenu: (e: MouseEvent, section: SectionView) => void;
  /** Opens TaskSectionStylePopup anchored at (x, y). Driven by the gear
   *  icon in the section header — the same popup is also reachable via
   *  the section context menu's "Style" entry. */
  openSectionStylePopup: (sectionId: string, x: number, y: number) => void;
  onSectionHeaderPointerDown: (e: PointerEvent) => void;
  addTaskToSection: (sectionId: string | null) => Promise<void> | void;
  onSectionBodyDrop: (
    e: DragEvent,
    sectionId: string | null,
  ) => Promise<void> | void;
}

export type { SectionView };
