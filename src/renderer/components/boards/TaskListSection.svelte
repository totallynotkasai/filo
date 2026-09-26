<script lang="ts">
  import StyleIcon from '../shared/StyleIcon.svelte';
  /**
   * TaskListSection — one rendered bucket (header + per-row dndzone +
   * inline quick-add / footer add-task button) for the Task List board.
   *
   * The section is the unit of drag for the outer
   * `tasklist-section-dnd` zone and also hosts the per-section row dndzone
   * (`type: 'tasklist-rows'`), so all of its drag wiring + drop-target
   * cueing belongs together.
   *
   * Prop-bundle pattern mirrors <TaskListRow>:
   *   - `controllers` carries the runtime controllers the section reads /
   *     invokes (drag controller, multi-select, frontmatter writers);
   *   - `callbacks` carries the section-level host actions
   *     (toggleCollapsed, rename commit/cancel, context menu, header
   *     pointerdown, quick-add submit, footer add-task, file body drop);
   *   - `rowCallbacks` is the {@link TaskListRowCallbacks} bundle forwarded
   *     verbatim to each <TaskListRow>;
   *   - `boardCtx` ({ placements, sections }) and `viewModel` are reused
   *     from the row's bundles so the host instantiates them once and
   *     passes the same reference into both layers.
   *
   * Section-mutable state (`editingSectionId`, `editingSectionTitle`,
   * `dragOverSectionId`, `inlineQuickAddSectionId`, `lastTargetedSectionId`)
   * is owned by the host and exposed here via `$bindable()` so the
   * `bind:value` inside the rename input + the inline assignments inside
   * pointer / drag handlers continue to drive host reactivity without an
   * extra setter indirection layer.
   */
  import { dndzone } from 'svelte-dnd-action';
  import TaskListRow from './TaskListRow.svelte';
  import { ACCENT_COLOR } from '../../constants/defaults';
  import { clearStaleDndStyles } from '../../lib/tasklist/clearStaleDndStyles';
  import type { ResolvedTaskStyle, ResolvedTaskSectionStyle } from '../../lib/styles/effectiveStyle';

  // True when the dragover/drop payload is either an OS file drag or a
  // vault-sidebar drag (single or multi). During `dragover`, browsers
  // withhold `dataTransfer.files` for OS file drags — only `types` carries
  // the sentinel `'Files'`. Test `types` exclusively.
  function dragHasFiles(e: DragEvent): boolean {
    const t = e.dataTransfer?.types;
    if (!t) return false;
    return (
      t.includes('Files')
      || t.includes('application/x-vault-file')
      || t.includes('application/x-vault-files')
    );
  }
  import type {
    FlatRowEntry,
    SectionView,
    TaskListRowBoardCtx,
    TaskListRowCallbacks,
    TaskListRowViewModel,
    TaskListSectionCallbacks,
    TaskListSectionControllers,
  } from './taskListRowProps';

  let {
    section,
    draggable,
    defaultSectionId,
    leadingSectionId,
    collapsedSubtasks,
    accentColor = ACCENT_COLOR,
    resolveTaskStyle,
    sectionStyle,
    titleFontSize,
    flatEntryByTileId,
    dndSectionsTrigger,
    viewModel,
    controllers,
    callbacks,
    rowCallbacks,
    boardCtx,
    editingSectionId = $bindable(),
    editingSectionTitle = $bindable(),
    dragOverSectionId = $bindable(),
    lastTargetedSectionId = $bindable(),
  }: {
    section: SectionView;
    draggable: boolean;
    defaultSectionId: string;
    leadingSectionId: string;
    collapsedSubtasks: Set<string>;
    accentColor?: string;
    /** Per-row cascade resolver. Forwarded to each <TaskListRow>; the row
     *  passes its own placement.style so each task can have its own
     *  override on top of the board / global task defaults. */
    resolveTaskStyle: (placementStyle?: Record<string, unknown> | null) => ResolvedTaskStyle;
    /** Cascade-resolved per-section style. Overrides board / global section defaults. */
    sectionStyle?: ResolvedTaskSectionStyle;
    /** Effective "Task List Title" font size (px) for section headers. */
    titleFontSize?: number;
    flatEntryByTileId: Map<string, FlatRowEntry>;
    /** Trigger object whose identity changes on every section-dnd commit;
     *  passed straight to `use:clearStaleDndStyles` so the action sweeps
     *  inline drag-leftover styles after a reorder. */
    dndSectionsTrigger: unknown;
    viewModel: TaskListRowViewModel;
    controllers: TaskListSectionControllers;
    callbacks: TaskListSectionCallbacks;
    rowCallbacks: TaskListRowCallbacks;
    boardCtx: TaskListRowBoardCtx;
    editingSectionId: string | null;
    editingSectionTitle: string;
    dragOverSectionId: string | null;
    lastTargetedSectionId: string | null;
  } = $props();

  // Inline styles derived from the cascade-resolved per-section style.
  // Empty strings cleanly produce "no override" → the CSS theme variables
  // continue to drive the surface.
  let sectionInlineStyle = $derived.by(() => {
    const s = sectionStyle;
    if (!s) return '';
    const parts: string[] = [];
    if (s.bodyColor) parts.push(`background-color: ${s.bodyColor}`);
    // Emit border declarations only when the cascade carries a real border
    // colour. Emitting `border-style` / `border-width` in isolation overrode
    // the `.tasklist-group` CSS rule's shorthand piecewise and left the
    // section drawing whatever colour the browser fell back to (sometimes
    // `currentColor` = `--text-primary`, which reads as a black ring on dark
    // themes). When no override is set, leave the CSS rule
    // (`border: 1px solid var(--ui-border-light)`) untouched.
    if (s.borderColor && s.borderWidth > 0) {
      parts.push(`border-color: ${s.borderColor}`);
      parts.push(`border-style: ${s.borderStyle || 'solid'}`);
      parts.push(`border-width: ${s.borderWidth}px`);
    }
    if (s.shadowIntensity > 0) parts.push(`box-shadow: 0 2px ${8 * s.shadowIntensity}px rgba(0,0,0,${0.3 * s.shadowIntensity})`);
    if (s.bodyTextColor) parts.push(`color: ${s.bodyTextColor}`);
    return parts.join('; ');
  });

  let sectionHeaderInlineStyle = $derived.by(() => {
    const s = sectionStyle;
    if (!s) return '';
    const parts: string[] = [];
    if (s.headerColor) parts.push(`background-color: ${s.headerColor}`);
    if (s.headerTextColor) parts.push(`color: ${s.headerTextColor}`);
    return parts.join('; ');
  });

  let sectionTitleFontSize = $derived(
    sectionStyle?.fontSizeTitle != null
      ? sectionStyle.fontSizeTitle
      : (typeof titleFontSize === 'number' ? titleFontSize : null),
  );

  // Accent bar swatch — mirrors KanbanColumn's resolvedAccent. The section
  // style schema doesn't carry a per-section accent today; fall back to the
  // board-level accent prop so the bar still picks up the user's theme.
  let resolvedAccent = $derived(accentColor || 'var(--accent-primary)');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tasklist-group tasklist-section"
  class:draggable
  class:section-drop-target={dragOverSectionId === (section.id ?? defaultSectionId)}
  data-section-id={section.id ?? ''}
  role="group"
  aria-label={section.title}
  style:--accent={resolvedAccent}
  style={sectionInlineStyle}
  use:clearStaleDndStyles={dndSectionsTrigger}
  ondragover={(e) => {
    // Section-root drop catcher for *file* drags only — vault sidebar
    // (singular / plural) and OS markdown drops. Task drags are owned by
    // the per-section dndzone inside `.group-rows` (cross-section moves
    // land via dndzone's shared `type: 'tasklist-rows'` glue).
    if (dragHasFiles(e)) {
      e.preventDefault();
      dragOverSectionId = section.id ?? defaultSectionId;
    }
  }}
  ondragenter={(e) => {
    // Auto-expand a collapsed section on file-drag enter so the drop target
    // is visible. Stays expanded after the drop — collapsing it back on
    // leave would be jumpy and surprising.
    if (!section.id || !section.collapsed) return;
    if (dragHasFiles(e)) {
      callbacks.toggleSectionCollapsed(section.id);
    }
  }}
  ondragleave={(e) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !(e.currentTarget as HTMLElement).contains(next)) {
      if (dragOverSectionId === (section.id ?? defaultSectionId)) {
        dragOverSectionId = null;
      }
    }
  }}
  ondrop={(e) => {
    // Only handle the drop here when the inner .group-rows / row handler
    // didn't already swallow it (they stopPropagation). For drops on the
    // section header, side padding, or a collapsed/empty section, this is
    // the only handler that fires.
    dragOverSectionId = null;
    void callbacks.onSectionBodyDrop(e, section.id);
  }}
>
  <div
    class="group-header section-header"
    role="group"
    aria-label={section.title}
    oncontextmenu={(e) => callbacks.openSectionContextMenu(e, section)}
    onpointerdown={draggable ? callbacks.onSectionHeaderPointerDown : undefined}
    style={sectionHeaderInlineStyle}
    style:cursor={draggable ? 'grab' : 'default'}
  >
    {#if section.id}
      <button
        class="group-collapse-btn"
        onclick={() => callbacks.toggleSectionCollapsed(section.id!)}
        aria-label={section.collapsed ? 'Expand section' : 'Collapse section'}
      >
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round"
          style:transform={section.collapsed ? 'rotate(-90deg)' : 'rotate(0deg)'}
          style:transition="transform 0.15s ease"
         aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    {/if}
    <div class="section-accent-bar" style:background-color={resolvedAccent} aria-hidden="true"></div>
    {#if section.id && editingSectionId === section.id}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="section-title-input"
        style={sectionTitleFontSize != null ? `font-size: ${sectionTitleFontSize}px;` : ''}
        bind:value={editingSectionTitle}
        onblur={callbacks.commitSectionRename}
        onkeydown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); callbacks.commitSectionRename(); }
          else if (e.key === 'Escape') { e.preventDefault(); callbacks.cancelSectionRename(); }
        }}
        autofocus
      />
    {:else}
      <h3
        class="group-title section-title"
        class:is-unsectioned={!section.id}
        style={sectionTitleFontSize != null ? `font-size: ${sectionTitleFontSize}px;` : ''}
        ondblclick={() => {
          if (!section.id) return;
          editingSectionId = section.id;
          editingSectionTitle = section.title;
        }}
      >{section.title}</h3>
    {/if}
    <span class="group-count">{section.rows.length}</span>
    {#if section.id && section.id !== defaultSectionId}
      <button
        class="section-style-btn"
        onpointerdown={(e) => e.stopPropagation()}
        onclick={(e) => {
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          callbacks.openSectionStylePopup(section.id!, rect.left, rect.bottom + 4);
        }}
        title="Section style"
        aria-label="Open style options for {section.title}"
      >
        <StyleIcon size={13} />
      </button>
    {/if}
  </div>

  {#if !section.collapsed}
    {@const zoneId = section.id ?? leadingSectionId}
    {@const rowItems = controllers.drag.rowItemsBySection[zoneId] ?? []}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="group-rows"
      ondragover={(e) => {
        // File drags only — task drags are owned by the per-section
        // dndzone below. Vault-sidebar singular/plural + OS markdown file
        // drops still land on `.group-rows` and bubble to `onSectionBodyDrop`.
        if (dragHasFiles(e)) {
          e.preventDefault();
          dragOverSectionId = section.id ?? defaultSectionId;
        }
      }}
      ondragleave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !(e.currentTarget as HTMLElement).contains(next)) {
          if (dragOverSectionId === (section.id ?? defaultSectionId)) {
            dragOverSectionId = null;
          }
        }
      }}
      ondrop={(e) => {
        // Stop bubble so the section-root ondrop doesn't double-handle the
        // same drop (it would call onSectionBodyDrop a second time and add
        // the same task twice).
        e.stopPropagation();
        dragOverSectionId = null;
        void callbacks.onSectionBodyDrop(e, section.id);
      }}
    >
      <div
        class="row-dnd-zone"
        class:is-empty={rowItems.length === 0}
        use:dndzone={{
          items: rowItems,
          type: 'tasklist-rows',
          dragDisabled: controllers.drag.rowDragDisabledBySection[zoneId] ?? true,
          flipDurationMs: 220,
          dropTargetStyle: {},
          transformDraggedElement: controllers.drag.transformDraggedRow,
        }}
        use:controllers.drag.clearStaleDndRowStyles={rowItems}
        onconsider={(e) => controllers.drag.onConsiderRows(zoneId, e)}
        onfinalize={(e) => controllers.drag.onFinalizeRows(zoneId, e)}
        ondragover={(e) => {
          // Duplicate of the .group-rows file-drop guard. svelte-dnd-action
          // can call stopPropagation() on dragover for events that fire on
          // its tracked rows, which prevents .group-rows / .tasklist-section
          // ondragover from running. Binding here ensures preventDefault
          // fires for file drags that land directly on a task row.
          if (dragHasFiles(e)) {
            e.preventDefault();
            dragOverSectionId = section.id ?? defaultSectionId;
          }
        }}
        ondrop={(e) => {
          if (dragHasFiles(e)) {
            e.preventDefault();
            e.stopPropagation();
            dragOverSectionId = null;
            void callbacks.onSectionBodyDrop(e, section.id);
          }
        }}
      >
        {#each rowItems as item (item.id)}
          {@const entry = flatEntryByTileId.get(item.id)}
          {#if entry}
            <TaskListRow
              row={entry.row}
              depth={entry.depth}
              sectionId={zoneId}
              {collapsedSubtasks}
              {accentColor}
              {resolveTaskStyle}
              {viewModel}
              controllers={{
                drag: controllers.drag,
                multiSelect: controllers.multiSelect,
                writers: controllers.writers,
              }}
              callbacks={rowCallbacks}
              {boardCtx}
            />
          {/if}
        {/each}
        {#if rowItems.length === 0}
          <div class="empty-group">No tasks</div>
        {/if}
      </div>
      <!-- Footer "Add task" button — the only per-section creation
           affordance (no header "+" / inline quick-add). Users who want token parsing use the
           board-level quick-add at the top. Sets
           `lastTargetedSectionId` here so the next sidebar "Add Task"
           click also lands in this section — explicit intent, not
           inferred from a pointerdown anywhere. -->
      <button
        class="section-add-task-footer"
        onpointerdown={(e) => e.stopPropagation()}
        onclick={(e) => {
          e.stopPropagation();
          const sid = section.id ?? defaultSectionId;
          lastTargetedSectionId = sid;
          void callbacks.addTaskToSection(sid);
        }}
        aria-label="Add task to {section.title}"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>Add task</span>
      </button>
    </div>
  {/if}
</div>

<style>
  /* Section card chrome — duplicated from TaskListBoard.svelte's non-
     sectioned `groupBy` path because Svelte's default CSS scoping doesn't
     bridge parent → child component scopes. The two paths render
     visually-identical section cards, so both `<style>` blocks carry the
     same rules; keep them in sync when tuning the card surface. The
     section-specific add-task affordances, header cursor, rename input,
     drop-target outline, and row dndzone wrapper rules sit below. */

  .tasklist-group {
    background: var(--ui-surface);
    border: 1px solid var(--ui-border-light);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: var(--ui-shadow);
    transition: box-shadow 0.15s ease, border-color 0.15s ease;
  }

  .tasklist-group:hover {
    box-shadow: var(--ui-shadow-lg);
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--ui-border-light);
    border-top-left-radius: 10px;
    border-top-right-radius: 10px;
  }

  .group-collapse-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    color: var(--text-tertiary);
    flex-shrink: 0;
    transition: background-color 0.15s ease;
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .group-collapse-btn:hover {
    background: var(--ui-surface-hover);
  }

  .group-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
    flex: 1;
    cursor: default;
  }

  /* Accent-tinted count badge — picks up `--accent` set on the section
     root from `resolvedAccent`. Matches `.column-count` in Kanban. */
  .group-count {
    font-size: 11px;
    font-weight: 500;
    color: var(--accent, var(--text-tertiary));
    background: color-mix(in srgb, var(--accent, var(--text-tertiary)) 14%, transparent);
    padding: 1px 6px;
    border-radius: 10px;
    flex-shrink: 0;
  }

  .group-rows {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .empty-group {
    text-align: center;
    padding: 12px;
    color: var(--text-tertiary);
    font-size: 13px;
    min-height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Drop logic lives on `.group-rows`; the empty-state label must not
       intercept drag events of its own or drops would silently no-op. */
    pointer-events: none;
  }

  .tasklist-section.draggable .section-header {
    cursor: grab;
  }
  .tasklist-section.draggable .section-header:active {
    cursor: grabbing;
  }

  .section-header {
    cursor: default;
  }

  .section-title {
    cursor: text;
  }

  .section-title.is-unsectioned {
    color: var(--text-tertiary);
    font-style: italic;
    cursor: default;
  }

  .section-title-input {
    flex: 1;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border-focus, var(--accent-primary));
    border-radius: 4px;
    padding: 2px 6px;
  }

  .section-title-input:focus:not(:focus-visible) {
    outline: none;
  }

  /* Dashed accent outline that flags the section currently under the
     cursor during a FILE drag (vault sidebar / OS markdown). Task drags
     get their visual cue from FLIP-shifted neighbours instead. */
  .section-drop-target {
    outline: 2px dashed var(--accent-primary, #4f7cff);
    outline-offset: -4px;
    background: color-mix(in srgb, var(--accent-primary, #4f7cff) 5%, transparent);
  }

  /* Style button (palette) in the section header — opens its ElementStylePopup.
     Mirrors KanbanColumn's `.column-action-btn`: hidden at rest, revealed
     on section hover / focus so the header reads as quiet by default and
     the affordance only appears when the user is engaging with the section. */
  .section-style-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    margin-left: 6px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-tertiary);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
  }
  .tasklist-section:hover .section-style-btn,
  .tasklist-section:focus-within .section-style-btn {
    opacity: 1;
  }
  .section-style-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }
  .section-style-btn:focus-visible {
    opacity: 1;
    outline: 2px solid var(--accent-primary, #4f7cff);
    outline-offset: 2px;
  }

  /* Accent bar in the section header — mirrors KanbanColumn's
     `.column-accent-bar` (3px × 18px pill) so the two board types share
     the same header chrome. */
  .section-accent-bar {
    width: 3px;
    height: 18px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  /* Footer "Add task" button — one-shot create at end-of-section. Distinct
     from the header "+" (which opens the inline quick-add input): this button
     creates a default-named task immediately. Sits below the rows so the
     user's eye lands on it after scanning the section. Shape mirrors
     KanbanColumn's `.add-tile-btn` (full-width, centred, dashed light
     border) so both board types share the same affordance. */
  .section-add-task-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin-top: 4px;
    padding: 8px;
    background: transparent;
    border: 1px dashed var(--ui-border-light);
    border-radius: 6px;
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
  }
  .section-add-task-footer:hover {
    color: var(--text-secondary);
    background: var(--ui-surface-hover);
  }
  .section-add-task-footer:focus-visible {
    color: var(--text-primary);
    outline: 2px solid var(--accent-primary, #4f7cff);
    outline-offset: 2px;
  }

  /* The row-level dndzone is a transparent wrapper around the rows. Inherits
     the 4px gap from `.group-rows` (now zero on that ancestor) so each row
     still has the original spacing between siblings. No padding / background
     so the section card's visual footprint is unchanged. */
  .row-dnd-zone {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .row-dnd-zone.is-empty {
    min-height: 56px;
  }

  /* Group header / collapse / title / count / rows are shared with the
     non-sectioned `groupBy` path and live in TaskListBoard.svelte's
     `<style>`. Empty-group sits there too because the non-section path
     reuses it. */
</style>
