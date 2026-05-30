<script lang="ts">
  /**
   * TaskItem — V7 task row.
   *
   * Pure presentational: receives the underlying `Tile` plus the frontmatter-
   * derived fields (`completed`, `priority`, `dueDate`) and emits intent
   * callbacks. The parent (TaskListBoard) is responsible for writing
   * frontmatter changes through the markdown sync layer.
   */
  import { untrack } from 'svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { documentStore } from '../../stores/document.svelte';
  import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import type { Tile } from '../../schema/index';
  import type { ResolvedTaskStyle } from '../../lib/styles/effectiveStyle';
  import { isEditableTextTarget } from '../../lib/utils/editableTarget';
  import { getAnchorBelow } from '../../lib/utils/popupAnchor';
  import { getBodyPreview, stripFrontmatter } from '../../lib/tasks/taskBodyText';
  import { resolveTextTileVaultPath } from '../../lib/boards/textTilePath';
  import TaskDatePicker from './TaskDatePicker.svelte';
  import TagBadge from '../tags/TagBadge.svelte';
  import TagsPopupMenu from '../tags/TagsPopupMenu.svelte';
  import { portal } from '../../lib/utils/portal';
  import type { Priority } from '../../lib/tasks/frontmatterReaders';
  import { PRIORITY_COLOR, PRIORITY_LABEL } from '../../constants/taskPriorities';
  import {
    formatDueDateAbsolute,
    formatTimeChip,
    isOverdue as isOverdueLib,
  } from '../../lib/tasks/dueDateFormat';

  let {
    tile,
    completed,
    priority,
    dueDate,
    dueTime = '',
    startDate = '',
    recurrence = '',
    selected = false,
    selectionSize = 0,
    accentColor,
    taskStyle,
    depth = 0,
    childCount = 0,
    childrenCollapsed = false,
    onToggleChildrenCollapsed,
    onToggleComplete,
    onCyclePriority,
    onSetPriority,
    onSetDueDate,
    onSetDueTime,
    onSetStartDate,
    onSetRecurrence,
    onSetNotes,
    onRename,
    onDelete,
    onOpen,
    onAddSubtask,
    canAddSubtask = true,
    onToggleLocked,
    onSelect,
    availableSections = [],
    currentSectionId = null,
    onMoveToSection,
    isDragging = false,
    dragCount = 0,
    onDragHandlePointerDown,
    onShowProperties,
    onEditTags,
  }: {
    tile: Tile;
    completed: boolean;
    priority: Priority;
    dueDate: string;
    dueTime?: string;
    startDate?: string;
    recurrence?: string;
    selected?: boolean;
    /** Total selection size on the host board. When >1 AND `selected` is
     *  true, the row's right-click "Move to…" entries become a bulk verb
     *  that operates on the entire selection — parallel to Kanban's bulk
     *  context menu. Otherwise the menu acts on this row alone. */
    selectionSize?: number;
    accentColor: string;
    taskStyle?: ResolvedTaskStyle;
    depth?: number;
    childCount?: number;
    childrenCollapsed?: boolean;
    onToggleChildrenCollapsed?: () => void;
    onToggleComplete: () => void;
    onCyclePriority: () => void;
    onSetPriority?: (priority: Priority) => void;
    onSetDueDate: (dueDate: string) => void;
    onSetDueTime?: (dueTime: string) => void;
    onSetStartDate?: (startDate: string) => void;
    onSetRecurrence?: (recurrence: string) => void;
    onSetNotes?: (body: string) => void;
    onRename: (title: string) => void;
    onDelete: (anchor?: { x: number; y: number }) => void;
    onOpen: () => void;
    onAddSubtask?: () => void;
    canAddSubtask?: boolean;
    onToggleLocked?: () => void;
    onSelect?: (mods: { shift: boolean; ctrl: boolean }) => void;
    /** Every section that exists on the parent board, in sort order. The
     *  "Move to section…" context-menu items are generated from this list. */
    availableSections?: Array<{ id: string; title: string }>;
    /** The section this row currently lives in; suppressed from the move-to
     *  list so the user can't no-op move into the same section. */
    currentSectionId?: string | null;
    /** Parent-supplied move action; receives the destination section id. */
    onMoveToSection?: (sectionId: string) => void;
    /** True when the row is part of the active drag block. Drives the
     *  popout / fade CSS so the user can see what's being moved. */
    isDragging?: boolean;
    /** Number of *additional* rows in a multi-row drag block (one less than
     *  the total). The primary dragged row shows a "+N" badge when > 0. */
    dragCount?: number;
    /** Drag-handle pointerdown hook. Parent uses this to arm its section's
     *  svelte-dnd-action zone for the next gesture. */
    onDragHandlePointerDown?: (e: PointerEvent) => void;
    /** Context-menu "Properties…" handler. Opens the read-only inspector. */
    onShowProperties?: () => void;
    /** Context-menu "Edit tags" handler. Opens the existing TagEditor popup
     *  via the parent's `tagEditorPopup` state. Anchored at the cursor when
     *  driven by right-click; the parent anchors it elsewhere if called
     *  from a different gesture. */
    onEditTags?: (anchor: { x: number; y: number }) => void;
  } = $props();

  // Style button dispatches a custom event that bubbles up to TaskListBoard's
  // scroll container — same pattern Mind Map and Kanban tile headers use.
  // Tags moved to the row context menu (Phase 5.3); Lock is a direct callback
  // because the toggle is a single store write (no popup to position).
  function openStylePopup(e: MouseEvent) {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    (e.currentTarget as HTMLElement).dispatchEvent(new CustomEvent('tile-style-popup', {
      bubbles: true,
      detail: { tile, x: rect.left, y: rect.bottom + 4 },
    }));
  }

  function openTagEditorButton(e: MouseEvent) {
    e.stopPropagation();
    if (!onEditTags) return;
    onEditTags(getAnchorBelow(e.currentTarget as HTMLElement));
  }

  // ── Inline notes (body preview + edit) ──
  //
  // The .md body lives in two possible places: documentStore (loaded if the
  // task or its source file has been opened) and vaultIndexStore (parsed by
  // the watcher on every file load). documentStore is preferred when loaded
  // because it reflects in-flight edits the watcher hasn't seen yet.
  //
  // Defensive strip: documentStore.body sometimes carries the YAML block —
  // historical convention has been inconsistent and a sibling writer may
  // round-trip the full file content into the cache. Strip on read so the
  // preview never shows frontmatter lines.

  let contentId = $derived((tile as Tile & { contentId?: string }).contentId ?? '');

  let backingPath = $derived.by(() => {
    void documentStore.frontmatterVersion;
    const t = tile as Tile & { contentId?: string; filePath?: string; file?: string };
    if (t.contentId) {
      const doc = documentStore.getDocument(t.contentId);
      if (doc?.filename) return doc.filename;
    }
    if (t.filePath) return t.filePath;
    if (t.file) return t.file;
    return resolveTextTileVaultPath(tile, tile.boardId) ?? `${tile.title || 'Untitled'}.md`;
  });

  let rawBody = $derived.by(() => {
    void documentStore.frontmatterVersion;
    void vaultIndexStore.version;
    if (contentId) {
      const doc = documentStore.getDocument(contentId);
      if (doc) return doc.body;
    }
    return vaultIndexStore.getMetadata(backingPath)?.content ?? '';
  });

  let bodyOnly = $derived(stripFrontmatter(rawBody));
  let notesPreview = $derived(getBodyPreview(rawBody, 120));

  let isExpanded = $state(false);
  let draftNotes = $state('');
  let notesEl: HTMLTextAreaElement | undefined = $state();

  // True when the user has switched the "Tasks" hover-buttons toggle Off in
  // General settings — keeps the row's action buttons permanently visible.
  let forceShowButtons = $derived(
    vaultStore.project?.settings?.general?.hoverButtons?.tasks === false,
  );

  // The note panel is a sticky toggle: clicking the button is the only path
  // that opens or closes it. Clicking other tasks, clicking outside the
  // textarea, or focusing another field does not collapse the panel — so
  // notes for several tasks can stay open at once while the user works.
  function toggleExpanded(e?: Event) {
    e?.stopPropagation();
    if (!isExpanded) {
      draftNotes = bodyOnly;
      isExpanded = true;
      queueMicrotask(() => notesEl?.focus());
    } else {
      commitNotes();
    }
  }

  // Leftmost chevron: only rendered when this row has children, and only
  // ever controls subtask collapse. Notes have their own dedicated button
  // ("Task Note") next to "Add Subtask" — the chevron no longer doubles up
  // as a notes affordance.
  function handleLeftChevron(e: Event) {
    e.stopPropagation();
    if (childCount > 0 && onToggleChildrenCollapsed) {
      onToggleChildrenCollapsed();
    }
  }

  function commitNotes() {
    isExpanded = false;
    if (!onSetNotes) return;
    if (draftNotes === bodyOnly) return;
    onSetNotes(draftNotes);
  }

  // Persist the draft without collapsing the panel — used on textarea blur so
  // edits flush to disk when focus moves elsewhere, but the panel itself only
  // closes via the note button or Escape.
  function saveNotesIfChanged() {
    if (!onSetNotes) return;
    if (draftNotes === bodyOnly) return;
    onSetNotes(draftNotes);
  }

  function onNotesKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); // H1: keep Escape off the global app:cancel
      isExpanded = false;
      draftNotes = bodyOnly;
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commitNotes();
    }
  }

  // `.task-item-wrap` owns border + shadow so one rounded outline encloses
  // the title strip and the expanded notes panel as a single card.
  let wrapInlineStyle = $derived.by(() => {
    if (!taskStyle) return '';
    const parts: string[] = [];
    if (taskStyle.borderColor) parts.push(`border-color: ${taskStyle.borderColor}`);
    if (taskStyle.borderStyle) parts.push(`border-style: ${taskStyle.borderStyle}`);
    if (taskStyle.borderWidth >= 0) parts.push(`border-width: ${taskStyle.borderWidth}px`);
    if (taskStyle.shadowIntensity >= 0)
      parts.push(`box-shadow: 0 1px ${6 * taskStyle.shadowIntensity}px rgba(0,0,0,${0.25 * taskStyle.shadowIntensity})`);
    return parts.join('; ');
  });

  // `.task-item` paints the title strip background + text colour only.
  let taskInlineStyle = $derived.by(() => {
    if (!taskStyle) return '';
    const parts: string[] = [];
    if (taskStyle.headerColor) parts.push(`background-color: ${taskStyle.headerColor}`);
    if (taskStyle.headerTextColor) parts.push(`color: ${taskStyle.headerTextColor}`);
    return parts.join('; ');
  });

  // `.task-notes-panel-inner` paints the expanded notes block. Body Colour
  // moved here (Phase 6 — was previously aliased onto the whole row), so
  // a user can dial the notes background independently of the row strip.
  let notesInlineStyle = $derived.by(() => {
    if (!taskStyle) return '';
    const parts: string[] = [];
    if (taskStyle.bodyColor) parts.push(`background-color: ${taskStyle.bodyColor}`);
    if (taskStyle.bodyTextColor) parts.push(`color: ${taskStyle.bodyTextColor}`);
    return parts.join('; ');
  });

  let titleFontSize = $derived(taskStyle?.fontSizeTitle);
  let bodyFontSize = $derived(taskStyle?.fontSizeBody);

  let isEditing = $state(false);
  let editTitle = $state(untrack(() => tile.title));

  function startEdit(e?: Event) {
    e?.stopPropagation();
    editTitle = tile.title;
    isEditing = true;
  }

  function commitEdit() {
    isEditing = false;
    if (editTitle.trim() && editTitle !== tile.title) {
      onRename(editTitle.trim());
    }
  }

  // Mouse-only users need a visible way to abandon the inline rename;
  // Escape covers the keyboard path. The flag suppresses the textbox's
  // own onblur commit when the user clicks Cancel, otherwise blur would
  // race with the click and re-commit the draft.
  let cancellingEdit = false;

  function cancelEdit(e?: Event) {
    e?.preventDefault();
    e?.stopPropagation();
    cancellingEdit = true;
    isEditing = false;
    editTitle = tile.title;
    queueMicrotask(() => { cancellingEdit = false; });
  }

  function handleTitleBlur() {
    if (cancellingEdit) return;
    commitEdit();
  }

  function onTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') commitEdit();
    else if (e.key === 'Escape') {
      cancelEdit();
    }
  }

  // `formatTimeChip` / `formatDueDateAbsolute` / `isOverdue` are imported from
  // `lib/tasks/dueDateFormat.ts` so the Task List and Kanban surfaces stay in
  // sync on how dates and overdue state are rendered.

  // ── Date picker popover ──
  //
  // Replaces the four-option context menu with an inline calendar grid.
  // Lives behind the existing chip click to keep the affordance identical;
  // a one-click chip still gets you a date with no extra navigation.
  let dueDatePickerOpen = $state(false);
  let dueDatePickerAnchor = $state<{ x: number; y: number } | null>(null);
  let startDatePickerOpen = $state(false);
  let startDatePickerAnchor = $state<{ x: number; y: number } | null>(null);

  function openRepeatMenu(anchor: { x: number; y: number }) {
    if (!onSetRecurrence) return;
    const presets: Array<{ id: string; label: string; value: string }> = [
      { id: 'none', label: 'None', value: '' },
      { id: 'daily', label: 'Daily', value: 'daily' },
      { id: 'weekly', label: 'Weekly', value: 'weekly' },
      { id: 'weekday', label: 'Weekdays (Mon–Fri)', value: 'weekday' },
      { id: 'monthly', label: 'Monthly', value: 'monthly' },
      { id: 'yearly', label: 'Yearly', value: 'yearly' },
    ];
    uiStore.showContextMenu(
      anchor.x,
      anchor.y,
      presets.map((p) => ({
        id: p.id,
        label: p.label,
        checked: recurrence === p.value,
        action: () => onSetRecurrence?.(p.value),
      })),
    );
  }

  function openDueDateMenu(e: MouseEvent) {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dueDatePickerAnchor = { x: rect.left, y: rect.bottom + 4 };
    dueDatePickerOpen = true;
  }

  function openStartDateMenu(e: MouseEvent) {
    e.stopPropagation();
    if (!onSetStartDate) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    startDatePickerAnchor = { x: rect.left, y: rect.bottom + 4 };
    startDatePickerOpen = true;
  }

  function openDateContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: Array<{ id: string; label: string; action?: () => void; divider?: boolean; danger?: boolean }> = [
      {
        id: 'pick-due',
        label: 'Pick due date…',
        action: () => {
          dueDatePickerAnchor = { x: rect.left, y: rect.bottom + 4 };
          dueDatePickerOpen = true;
        },
      },
    ];
    if (onSetStartDate) {
      items.push({
        id: 'pick-start',
        label: startDate ? `Start: ${startDate}` : 'Set start date…',
        action: () => {
          startDatePickerAnchor = { x: rect.left, y: rect.bottom + 4 };
          startDatePickerOpen = true;
        },
      });
    }
    if (onSetRecurrence) {
      items.push({
        id: 'repeat',
        label: recurrence ? `Repeat: ${recurrence}…` : 'Repeat…',
        action: () => openRepeatMenu({ x: rect.left, y: rect.bottom + 4 }),
      });
    }
    if (dueDate || startDate || recurrence) {
      items.push({ id: 'sep', label: '', divider: true });
      if (dueDate) {
        items.push({ id: 'clear-due', label: 'Clear due date', danger: true, action: () => onSetDueDate('') });
      }
      if (startDate && onSetStartDate) {
        items.push({ id: 'clear-start', label: 'Clear start date', danger: true, action: () => onSetStartDate?.('') });
      }
    }
    uiStore.showContextMenu(e.clientX, e.clientY, items);
  }

  function isOverdue(): boolean {
    return isOverdueLib(dueDate, completed);
  }

  function handleContextMenu(e: MouseEvent) {
    if (isEditableTextTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    // Build "Move to section…" entries from the parent's section list.
    // Flat — uiStore.showContextMenu doesn't support submenus, so each section
    // is its own item. Hidden when there's no choice (single section or no
    // move callback). Skipping the current section avoids no-op moves.
    //
    // When the right-clicked row is part of a multi-selection (selectionSize
    // > 1), the labels switch to bulk wording. The parent's
    // `onMoveToSection` callback inspects the selection state itself and
    // routes to bulk vs single — we don't need a separate callback prop.
    const isBulkMove = selected && selectionSize > 1;
    const moveItems = (onMoveToSection && availableSections.length > 1)
      ? availableSections
          .filter((s) => s.id !== currentSectionId)
          .map((s) => ({
            id: `move-to-${s.id}`,
            label: isBulkMove
              ? `Move ${selectionSize} tasks to: ${s.title}`
              : `Move to: ${s.title}`,
            icon: 'M5 12h14M13 5l7 7-7 7',
            action: () => onMoveToSection?.(s.id),
          }))
      : [];
    const cursor = { x: e.clientX, y: e.clientY };
    uiStore.showContextMenu(
      e.clientX,
      e.clientY,
      [
        { id: 'open', label: 'Open as Document', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', action: onOpen },
        { id: 'edit', label: 'Rename Task', icon: 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z', action: () => startEdit() },
        ...(onAddSubtask && canAddSubtask
          ? [{ id: 'add-subtask', label: 'Add Subtask', icon: 'M12 5v14M5 12h14', action: onAddSubtask }]
          : []),
        { id: 'toggle', label: completed ? 'Mark Incomplete' : 'Mark Complete', icon: 'M20 6L9 17l-5-5', action: onToggleComplete },
        { id: 'priority', label: 'Cycle Priority', icon: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3', action: onCyclePriority },
        ...(onEditTags
          ? [{ id: 'edit-tags', label: 'Edit tags', icon: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z', action: () => onEditTags?.(cursor) }]
          : []),
        ...(moveItems.length > 0
          ? [{ id: 'move-sep', label: '', divider: true }, ...moveItems]
          : []),
        ...(onShowProperties
          ? [
              { id: 'props-sep', label: '', divider: true },
              { id: 'properties', label: 'Properties…', icon: 'M12 8v4l3 3M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z', action: onShowProperties },
            ]
          : []),
        { id: 'div', label: '', divider: true },
        { id: 'delete', label: 'Delete Task', icon: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', danger: true, action: onDelete },
      ],
      tile.id,
    );
  }

  function handleRowClick(e: MouseEvent) {
    if (isEditing) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('textarea')) return;
    // Title span owns its own dblclick→rename gesture.
    if (target.closest('.task-title')) return;
    if (!onSelect) return;
    // Plain click → single-select (matches Kanban card click). Shift / Ctrl /
    // Cmd extend or toggle the selection. The MultiSelectController handles
    // the "click the lone selected row again ⇒ clear" toggle so a plain
    // click never silently leaves the selection in an inconsistent state.
    e.preventDefault();
    onSelect({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
  }

  // Row-focused keyboard shortcuts. The board-level handler in TaskListBoard
  // intercepts arrow keys + Tab so the surrounding keys (Space / Enter /
  // priority digits / D / Delete) reach this handler only when the row keeps
  // focus. Any change here should stay in lock-step with the parent's
  // `handleBoardKeydown`.
  function handleRowKeydown(e: KeyboardEvent) {
    if (isEditing) return;
    if (isEditableTextTarget(e.target)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      startEdit();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      onToggleComplete();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onDelete();
      return;
    }
    if (e.key === 'd' || e.key === 'D') {
      // The shortcut needs a screen anchor for the popover. Use the row's
      // own client rect rather than the activeElement to stay consistent
      // when the user opened the popover by mouse and then by key.
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      dueDatePickerAnchor = { x: r.left + 60, y: r.bottom + 4 };
      dueDatePickerOpen = true;
      e.preventDefault();
      return;
    }
    if (e.key >= '0' && e.key <= '4' && onSetPriority) {
      const map: Record<string, Priority> = {
        '0': 'none',
        '1': 'urgent',
        '2': 'high',
        '3': 'medium',
        '4': 'low',
      };
      const p = map[e.key];
      if (p) {
        e.preventDefault();
        onSetPriority(p);
      }
    }
  }

  // Tag click → open TagsPopupMenu at cursor (mirrors TileContainer pattern).
  let tagPopup = $state<{ tagName: string; x: number; y: number } | null>(null);
  function handleTagClick(tagName: string, e: MouseEvent) {
    e.stopPropagation();
    if (tagPopup?.tagName === tagName) {
      tagPopup = null;
    } else {
      tagPopup = { tagName, x: e.clientX, y: e.clientY };
    }
  }
  function closeTagPopup() { tagPopup = null; }
</script>

<div
  class="task-item-wrap"
  class:expanded={isExpanded}
  class:selected
  class:is-dragging={isDragging}
  class:force-show-buttons={forceShowButtons}
  style:--task-depth={depth}
  style={wrapInlineStyle}
  data-task-id={tile.id}
  data-drag-count={dragCount > 0 ? dragCount : null}
>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="task-item"
  class:completed
  class:is-subtask={depth > 0}
  class:locked={tile.locked === true}
  oncontextmenu={handleContextMenu}
  onclick={handleRowClick}
  onkeydown={handleRowKeydown}
  role="listitem"
  tabindex="0"
  aria-current={selected ? 'true' : undefined}
  data-task-id={tile.id}
  style={taskInlineStyle}
>
  {#if childCount > 0}
    <button
      class="task-expand-btn children-mode"
      class:expanded={!childrenCollapsed}
      onclick={handleLeftChevron}
      title={childrenCollapsed ? `Show ${childCount} subtask${childCount === 1 ? '' : 's'}` : 'Hide subtasks'}
      aria-expanded={!childrenCollapsed}
      aria-label={childrenCollapsed ? 'Expand subtasks' : 'Collapse subtasks'}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  {:else}
    <span class="task-chevron-spacer" aria-hidden="true"></span>
  {/if}

  {#if tile.locked !== true}
    <button
      type="button"
      class="task-drag-handle"
      title="Drag to reorder (or use Alt+Up / Alt+Down)"
      aria-label={`Drag handle for ${tile.title}. Drag to reorder, or use Alt+Up and Alt+Down with this row focused.`}
      onpointerdown={(e) => onDragHandlePointerDown?.(e)}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="6" r="1.5" />
        <circle cx="16" cy="6" r="1.5" />
        <circle cx="8" cy="12" r="1.5" />
        <circle cx="16" cy="12" r="1.5" />
        <circle cx="8" cy="18" r="1.5" />
        <circle cx="16" cy="18" r="1.5" />
      </svg>
    </button>
  {:else}
    <span class="task-drag-handle task-drag-handle-locked" aria-label="Task locked — reorder disabled" role="img" title="Locked">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    </span>
  {/if}

  <button
    class="task-checkbox"
    onclick={(e) => { e.stopPropagation(); onToggleComplete(); }}
    title={completed ? 'Mark incomplete' : 'Mark complete'}
    style:border-color={completed ? accentColor : 'var(--ui-border)'}
    style:background-color={completed ? accentColor : 'transparent'}
  >
    {#if completed}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    {/if}
  </button>

  <div class="task-content">
    {#if isEditing}
      <div class="task-title-edit-row">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="task-title-input"
          style={titleFontSize != null ? `font-size: ${titleFontSize}px;` : ''}
          type="text"
          bind:value={editTitle}
          onblur={handleTitleBlur}
          onkeydown={onTitleKeydown}
          onclick={(e) => e.stopPropagation()}
          autofocus
        />
        <button
          type="button"
          class="task-title-edit-action confirm"
          title="Save (Enter)"
          aria-label="Save rename"
          onmousedown={(e) => e.preventDefault()}
          onclick={(e) => { e.stopPropagation(); commitEdit(); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
        <button
          type="button"
          class="task-title-edit-action cancel"
          title="Cancel (Esc)"
          aria-label="Cancel rename"
          onmousedown={(e) => e.preventDefault()}
          onclick={(e) => { e.stopPropagation(); cancelEdit(e); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    {:else}
      <span
        class="task-title"
        style={titleFontSize != null ? `font-size: ${titleFontSize}px;` : ''}
        tabindex="0"
        role="button"
        aria-label={`Task title: ${tile.title}. Press F2 or Enter to rename.`}
        ondblclick={(e) => startEdit(e)}
        onkeydown={(e) => {
          if (e.key === 'F2' || e.key === 'Enter') {
            e.preventDefault();
            startEdit(e);
          }
        }}
      >{tile.title}</span>
    {/if}
  </div>

  {#if onAddSubtask && canAddSubtask}
    <button
      class="task-add-subtask-btn"
      onclick={(e) => { e.stopPropagation(); onAddSubtask?.(); }}
      title="Add subtask"
      aria-label="Add subtask to {tile.title}"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  {/if}

  {#if onSetNotes}
    <button
      class="task-note-btn"
      class:has-notes={notesPreview.length > 0}
      class:active={isExpanded}
      onclick={(e) => { e.stopPropagation(); toggleExpanded(); }}
      title={isExpanded ? 'Hide task note' : (notesPreview ? 'Edit task note' : 'Add task note')}
      aria-label={isExpanded ? 'Hide task note' : 'Show task note'}
      aria-pressed={isExpanded}
    >
      {#if notesPreview.length > 0}
        <!-- Filled sticky-note icon: visually distinct from the empty
             outline above. Replaces the previous blue-dot indicator so
             "has notes" reads as state, not a notification. -->
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
          <path d="M14 2v6h6" fill="none" stroke="var(--ui-surface-raised, #fff)" />
          <line x1="8" y1="13" x2="16" y2="13" stroke="var(--ui-surface-raised, #fff)" stroke-width="1.5" />
          <line x1="8" y1="17" x2="13" y2="17" stroke="var(--ui-surface-raised, #fff)" stroke-width="1.5" />
        </svg>
      {:else}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      {/if}
    </button>
  {/if}

  {#if onToggleLocked}
    <button
      class="task-meta-btn task-lock-btn"
      class:active={tile.locked}
      title={tile.locked ? 'Unlock task' : 'Lock task'}
      aria-label={tile.locked ? 'Unlock task' : 'Lock task'}
      aria-pressed={tile.locked === true}
      onclick={(e) => { e.stopPropagation(); onToggleLocked(); }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {#if tile.locked}
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        {:else}
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
        {/if}
      </svg>
    </button>
  {/if}

  {#if onEditTags}
    <button
      class="task-meta-btn"
      title="Edit tags"
      aria-label="Edit tags"
      onclick={openTagEditorButton}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
        <line x1="7" y1="7" x2="7.01" y2="7"/>
      </svg>
    </button>
  {/if}

  <button
    class="task-meta-btn"
    title="Style"
    aria-label="Task style options"
    onclick={openStylePopup}
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  </button>

  {#if priority !== 'none'}
    <button
      class="task-priority"
      onclick={(e) => { e.stopPropagation(); onCyclePriority(); }}
      title="Priority: {priority}"
      style:color={PRIORITY_COLOR[priority]}
    >
      {PRIORITY_LABEL[priority]}
    </button>
  {:else}
    <button
      class="task-priority task-priority-empty"
      onclick={(e) => { e.stopPropagation(); onCyclePriority(); }}
      title="Set priority"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
        <line x1="4" y1="22" x2="4" y2="15"/>
      </svg>
    </button>
  {/if}

  {#if recurrence}
    <button
      class="task-recurrence"
      title={`Repeats ${recurrence}`}
      aria-label={`Repeats ${recurrence}`}
      onclick={openDueDateMenu}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
  {/if}

  {#if startDate}
    <button
      class="task-start-date"
      title={`Starts ${startDate}`}
      aria-label={`Starts ${startDate}`}
      onclick={openStartDateMenu}
      oncontextmenu={openDateContextMenu}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="5 12 12 19 19 12" transform="rotate(-90 12 12)" />
      </svg>
      {formatDueDateAbsolute(startDate)}
    </button>
  {/if}

  {#if dueDate}
    <button
      class="task-due task-due-clickable"
      class:overdue={isOverdue()}
      title="Change due date"
      aria-label="Change due date"
      onclick={openDueDateMenu}
      oncontextmenu={openDateContextMenu}
    >
      {formatDueDateAbsolute(dueDate)}{dueTime ? ` ${formatTimeChip(dueTime)}` : ''}
    </button>
  {:else}
    <button
      class="task-due-btn"
      title="Set due date"
      aria-label="Set due date"
      onclick={openDueDateMenu}
      oncontextmenu={openDateContextMenu}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
    </button>
  {/if}

  <button
    class="task-delete-btn"
    onclick={(e) => {
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      onDelete({ x: r.left, y: r.bottom + 4 });
    }}
    title="Delete task"
    aria-label="Delete task {tile.title}"
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  </button>
</div>

{#if onSetNotes}
  <!--
    Notes panel uses a CSS grid-template-rows 0fr ↔ 1fr trick so opening /
    closing physically pushes any subtasks below this row down with a smooth
    transition, while only animating GPU-friendly properties (per CLAUDE.md).
    The inner content must have `min-height: 0; overflow: hidden` for the
    grid to actually collapse to zero.
  -->
  <div class="task-notes-panel" class:open={isExpanded} aria-hidden={!isExpanded}>
    <div class="task-notes-panel-inner" style={notesInlineStyle}>
      {#if isExpanded}
        <textarea
          bind:this={notesEl}
          bind:value={draftNotes}
          class="task-notes-textarea"
          style={bodyFontSize != null ? `font-size: ${bodyFontSize}px;` : ''}
          placeholder="Add a task note — Ctrl+Enter to save, Esc to cancel"
          rows="3"
          onkeydown={onNotesKeydown}
          onblur={saveNotesIfChanged}
        ></textarea>
      {/if}
      {#if tile.tags.length > 0}
        <ul class="task-notes-tags" aria-label="Tags for {tile.title}">
          {#each tile.tags as name (name)}
            <li>
              <TagBadge tagName={name} size="sm" onClick={(e) => handleTagClick(name, e)} />
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}
</div>

{#if dueDatePickerOpen && dueDatePickerAnchor}
  <TaskDatePicker
    value={dueDate}
    time={dueTime}
    anchor={dueDatePickerAnchor}
    withTime={!!onSetDueTime}
    label="Due date"
    onPick={(iso) => onSetDueDate(iso)}
    onPickTime={(t) => onSetDueTime?.(t)}
    onClear={() => { onSetDueDate(''); onSetDueTime?.(''); }}
    onClose={() => { dueDatePickerOpen = false; dueDatePickerAnchor = null; }}
  />
{/if}

{#if startDatePickerOpen && startDatePickerAnchor && onSetStartDate}
  <TaskDatePicker
    value={startDate}
    anchor={startDatePickerAnchor}
    label="Start date"
    onPick={(iso) => onSetStartDate?.(iso)}
    onClear={() => onSetStartDate?.('')}
    onClose={() => { startDatePickerOpen = false; startDatePickerAnchor = null; }}
  />
{/if}

{#if tagPopup}
  <div
    use:portal
    class="tag-popup-overlay"
    onclick={closeTagPopup}
    onkeydown={(e) => { if (e.key === 'Escape') closeTagPopup(); }}
    role="presentation"
  ></div>
  <div
    use:portal
    class="tag-popup-anchor"
    style="position: fixed; left: {tagPopup.x}px; top: {tagPopup.y}px; z-index: var(--z-tile-popup);"
  >
    <TagsPopupMenu tagName={tagPopup.tagName} onClose={closeTagPopup} />
  </div>
{/if}

<style>
  .task-item-wrap {
    --task-depth: 0;
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--ui-surface-raised);
    border: 1px solid var(--ui-border-light);
    border-radius: 8px;
    /* Clips notes-panel-inner to the rounded corners so Body Colour fills
       cleanly into the bottom; also makes the wrapper the single outline
       around both zones when a Border Colour override is set. */
    overflow: hidden;
    transition: box-shadow 0.2s ease, opacity 0.2s ease, transform 0.16s ease;
    /* 28px per depth level — matches Google Tasks visual indentation. */
    margin-left: calc(var(--task-depth) * 28px);
  }

  /* Popout / fade applied to the source row(s) during a drag. The native
     browser drag image is suppressed at the drag-start handler by setting a
     1×1 transparent setDragImage, so this is the *only* visual feedback for
     "which row is moving". Steady-state styles apply even when transitions
     are zeroed by prefers-reduced-motion so the cognitive cue remains.
     Opacity tuned to 0.4 to match Kanban's `.in-drag-block`; pointer-events
     locked out so passenger rows can't catch a pointermove meant for the
     clone (svelte-dnd-action positions the clone under the cursor; a
     passenger row underneath would otherwise steal hover/focus). */
  .task-item-wrap.is-dragging {
    opacity: 0.4;
    pointer-events: none;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
    z-index: 2;
  }

  @media (prefers-reduced-motion: no-preference) {
    .task-item-wrap.is-dragging {
      transform: scale(1.015);
    }
  }

  /* Multi-drag count badge — only the primary dragged row sets a positive
     data-drag-count attribute, so the badge appears exactly once and tells
     the user how many extra rows are following. */
  .task-item-wrap.is-dragging[data-drag-count]:not([data-drag-count='0'])::after {
    content: '+' attr(data-drag-count);
    position: absolute;
    top: -8px;
    right: -8px;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 11px;
    background: var(--accent-primary);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    line-height: 22px;
    text-align: center;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
    pointer-events: none;
  }

  /* Subtasks read as visually subordinate but stay grabbable + readable. */
  .task-item-wrap:has(.is-subtask) {
    background: var(--ui-surface);
    border-color: var(--ui-border-light);
  }

  .task-item-wrap:hover {
    box-shadow: var(--ui-shadow);
  }

  .task-item-wrap.expanded {
    box-shadow: var(--ui-shadow);
  }

  .task-item-wrap.selected {
    border-color: var(--accent-primary);
    background: color-mix(in srgb, var(--accent-primary) 8%, var(--ui-surface-raised));
    box-shadow: 0 0 0 1px var(--accent-primary) inset;
  }

  .task-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: transparent;
    border: none;
    /* Top corners only — wrap's overflow:hidden clips the bottom; rounding
       it here would expose a crescent of wrap background when Header Color
       and Body Color are both set. */
    border-radius: 8px 8px 0 0;
    cursor: pointer;
  }

  .task-expand-btn,
  .task-chevron-spacer {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
  }

  .task-expand-btn {
    border-radius: 4px;
    color: var(--text-tertiary);
    transition: color 0.15s ease, transform 0.15s ease, background-color 0.15s ease;
    cursor: pointer;
    background: transparent;
    border: none;
  }

  .task-expand-btn:hover {
    color: var(--text-primary);
    background: var(--ui-surface-hover);
  }

  .task-expand-btn.expanded {
    transform: rotate(90deg);
    color: var(--text-primary);
  }

  /* ── Task Note panel (slides open with grid-row trick) ──
     Animating grid-template-rows from 0fr → 1fr keeps the animation on the
     compositor while *physically* pushing siblings (subtasks) down, which
     is what the user asked for. Inner element gets min-height: 0 so the
     row can actually collapse to zero. */
  .task-notes-panel {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition: grid-template-rows 180ms ease, opacity 140ms ease;
  }

  .task-notes-panel.open {
    grid-template-rows: 1fr;
    opacity: 1;
  }

  .task-notes-panel-inner {
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .task-notes-panel.open .task-notes-panel-inner {
    padding: 4px 12px 8px;
  }

  .task-notes-tags {
    align-self: flex-start;
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--tag-row-gap);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .task-notes-tags li { display: inline-flex; }

  @media (prefers-reduced-motion: reduce) {
    .task-notes-panel {
      transition: none;
    }
  }

  .task-notes-textarea {
    width: 100%;
    min-height: 60px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: 12px;
    line-height: 1.5;
    color: inherit;
    /* Transparent so the parent's Body Colour (or default --ui-surface-raised)
       shows through the editable area. The textarea's bordered box remains the
       editing affordance; the fill colour belongs to the whole notes panel. */
    background: transparent;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    resize: vertical;
    transition: border-color 0.15s ease;
  }

  .task-notes-textarea:focus {
    border-color: var(--ui-border-focus, var(--accent-primary));
  }

  .task-notes-textarea:focus:not(:focus-visible) {
    outline: none;
  }

  .task-item:focus-visible {
    outline: 2px solid var(--ui-border-focus);
    outline-offset: 1px;
  }

  .task-item-wrap:has(.task-item.completed) {
    opacity: 0.6;
  }

  .task-item.completed .task-title {
    text-decoration: line-through;
    color: var(--text-tertiary);
  }

  .task-drag-handle {
    flex-shrink: 0;
    cursor: grab;
    display: flex;
    align-items: center;
    /* Reset button user-agent styles since we render as a <button> for a11y */
    background: transparent;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
  }
  .task-drag-handle:focus-visible {
    outline: 2px solid var(--accent-primary, currentColor);
    outline-offset: 2px;
    border-radius: 3px;
  }

  .task-checkbox {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    border: 2px solid var(--ui-border);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background-color 0.15s ease, border-color 0.15s ease;
    cursor: pointer;
  }

  .task-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .task-title {
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    word-break: break-word;
  }

  .task-title-edit-row {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
  }

  .task-title-input {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--text-primary);
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border-focus);
    border-radius: 4px;
    padding: 2px 6px;
  }

  .task-title-input:focus:not(:focus-visible) {
    outline: none;
  }

  .task-title-edit-action {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    border: 1px solid var(--ui-border-light);
    background: var(--ui-surface);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }

  .task-title-edit-action.confirm:hover {
    background: color-mix(in srgb, var(--accent-primary) 12%, var(--ui-surface));
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .task-title-edit-action.cancel:hover {
    background: var(--menu-danger-bg, rgba(255, 107, 107, 0.1));
    border-color: var(--accent-danger);
    color: var(--accent-danger);
  }

  .task-add-subtask-btn,
  .task-note-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
    position: relative;
  }

  .task-item-wrap:hover .task-add-subtask-btn,
  .task-item-wrap:focus-within .task-add-subtask-btn,
  .task-item-wrap:hover .task-note-btn,
  .task-item-wrap:focus-within .task-note-btn {
    opacity: 1;
  }

  /* When the task already has note content, keep the note button visible
     so the filled-icon state is discoverable without hovering. */
  .task-note-btn.has-notes,
  .task-note-btn.active {
    opacity: 1;
    color: var(--text-secondary);
  }

  .task-note-btn.active {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .task-add-subtask-btn:hover,
  .task-note-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  /* Tags / Lock / Style trio — same hover-reveal pattern as Add Subtask.
     Lock stays visible when the task is locked so the affordance is
     discoverable; the others are pure hover affordances. */
  .task-meta-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--text-tertiary);
    background: transparent;
    border: none;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
  }

  .task-item-wrap:hover .task-meta-btn,
  .task-item-wrap:focus-within .task-meta-btn {
    opacity: 1;
  }

  .task-meta-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .task-lock-btn.active {
    opacity: 1;
    color: var(--accent-primary);
  }

  /* Locked task: drag handle is replaced with a static padlock badge so the
     row visually communicates "non-movable" even when not hovered. The
     not-allowed cursor reinforces that drag is impossible — Item M5 in the
     Phase C audit: users would otherwise hover-grab repeatedly without
     feedback. */
  .task-drag-handle-locked {
    cursor: not-allowed;
    color: var(--accent-primary);
    opacity: 0.7;
  }

  /* The whole locked row also reports drag as unavailable wherever a
     non-handle drop zone might still be hovered, keeping the affordance
     consistent. */
  .task-item.locked .task-drag-handle,
  .task-item.locked.task-item:hover .task-drag-handle {
    cursor: not-allowed;
  }

  .task-item.locked {
    /* Subtle visual cue beyond the badge — slightly desaturate the row. */
    background: color-mix(in srgb, var(--accent-primary) 4%, transparent);
  }

  .task-priority {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--ui-surface-hover);
    cursor: pointer;
    transition: background-color 0.15s ease;
    border: none;
  }

  .task-priority:hover {
    background: var(--ui-surface-active);
  }

  .task-priority-empty {
    background: transparent;
    color: var(--text-tertiary);
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .task-priority-empty:hover {
    background: var(--ui-surface-hover);
  }

  .task-item-wrap:hover .task-priority-empty {
    opacity: 1;
  }

  .task-recurrence {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: var(--text-tertiary);
    background: var(--ui-surface-hover);
    border: none;
    cursor: pointer;
    transition: color 0.15s ease, background-color 0.15s ease;
  }

  .task-recurrence:hover {
    color: var(--text-primary);
    background: var(--ui-surface-active);
  }

  .task-start-date {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--text-tertiary);
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--ui-surface-hover);
    border: 1px solid transparent;
    cursor: pointer;
    transition: border-color 0.1s ease;
  }

  .task-start-date:hover {
    border-color: var(--ui-border);
    color: var(--text-secondary);
  }

  .task-due {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-tertiary);
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--ui-surface-hover);
  }

  .task-due-clickable {
    border: 1px solid transparent;
    cursor: pointer;
    transition: border-color 0.1s ease;
  }

  .task-due-clickable:hover,
  .task-due-clickable:focus-visible {
    border-color: var(--ui-border);
  }

  .task-due.overdue {
    color: var(--accent-danger);
    background: var(--menu-danger-bg);
  }

  .task-due-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--text-tertiary);
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease;
    cursor: pointer;
    background: transparent;
    border: none;
  }

  .task-item-wrap:hover .task-due-btn {
    opacity: 1;
  }

  .task-due-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }

  .task-delete-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--text-tertiary);
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease;
    cursor: pointer;
    background: transparent;
    border: none;
  }

  .task-item-wrap:hover .task-delete-btn {
    opacity: 1;
  }

  .task-delete-btn:hover {
    background: rgba(255, 107, 107, 0.1);
    color: var(--accent-danger);
  }

  /* When General settings → Toggle Hover Buttons → Tasks is Off, the wrapper
     receives this class and every hover-revealed button is forced to full
     opacity regardless of hover/focus state. */
  .task-item-wrap.force-show-buttons .task-add-subtask-btn,
  .task-item-wrap.force-show-buttons .task-note-btn,
  .task-item-wrap.force-show-buttons .task-meta-btn,
  .task-item-wrap.force-show-buttons .task-due-btn,
  .task-item-wrap.force-show-buttons .task-delete-btn,
  .task-item-wrap.force-show-buttons .task-priority-empty {
    opacity: 1;
  }
</style>
