<script lang="ts">
  import StyleIcon from '../shared/StyleIcon.svelte';
  /**
   * ConnectionLabel — Editable label that rides along a connection path.
   * Positioned at a parametric position (0–1) on the path.
   * Shows edit/style/lock/delete controls on hover or selection.
   */
  import type { Connection } from '../../schema/index';
  import { onDestroy, getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { connectionsStore } from '../../stores/connections.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { registerComponentFlush } from '../../lib/boards/componentFlush';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  import { historyStore } from '../../stores/history.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { UpdateConnectionCommand } from '../../commands/index';
  import { createLabelEditor } from '../../lib/editor/createEditor';
  import { tiptapToolbar } from '../../lib/editor/toolbarConfig';
  import { getClosestTOnPolyline, type PathPoint } from '../../lib/connections/pathRouter';
  import { effectiveConnectionLabelStyle } from '../../lib/styles/effectiveStyle';
  import { sanitizeInlineHtml } from '../../lib/utils/sanitizeHtml';
  import type { Editor } from '@tiptap/core';

  let {
    connection,
    pathElement,
    pathD = '',
    editing: editingProp = false,
    oncontextmenu,
    onstyleclick,
    oneditdone,
  }: {
    connection: Connection;
    pathElement: SVGPathElement | null;
    pathD?: string;
    editing?: boolean;
    oncontextmenu?: (e: MouseEvent, conn: Connection) => void;
    onstyleclick?: (e: MouseEvent, conn: Connection) => void;
    oneditdone?: () => void;
  } = $props();

  let isEditing = $state(false);
  let editText = $state('');
  let showControls = $state(false);
  let labelEditorElement = $state<HTMLDivElement | null>(null);
  let labelEditor: Editor | null = null;
  let isDragging = $state(false);
  let dragStartPosition = $state(0.5);
  let hideTimeout: ReturnType<typeof setTimeout> | null = null;

  // Path visibility state (for eye icon)
  let isPathHidden = $derived(
    connection.visibility === 'hidden' || connection.visibility === 'hidden-locked',
  );

  // Cleanup timeout on destroy
  $effect(() => {
    return () => { if (hideTimeout) clearTimeout(hideTimeout); };
  });

  // Position on path — pathD dependency ensures re-computation when path geometry changes.
  // Defensive clamp at render time. The schema (`ConnectionLabelSchema.position`)
  // already bounds the field to `[0, 1]`, but a hand-edited `.board.json` or
  // a schema bypass would otherwise place the label past the
  // path's end (or before its start), pinning it off-canvas where the
  // user can't grab it.
  let labelPos = $derived.by(() => {
    if (!pathElement) return { x: 0, y: 0 };
    void pathD; // reactive dependency: re-derive when path geometry changes
    const length = pathElement.getTotalLength();
    const t = Math.max(0, Math.min(1, connection.label.position));
    const point = pathElement.getPointAtLength(t * length);
    return { x: point.x, y: point.y };
  });

  let isLabelHidden = $derived(
    (connection.labelVisibility ?? 'visible') === 'hidden' || (connection.labelVisibility ?? 'visible') === 'hidden-locked',
  );

  // Locked states pin the label's visibility — the global Hide-All
  // Labels toggle skips labels that have been explicitly locked.
  let isLabelLocked = $derived(
    (connection.labelVisibility ?? 'visible') === 'visible-locked' ||
      (connection.labelVisibility ?? 'visible') === 'hidden-locked',
  );

  let inConnectionMode = $derived(connectionsStore.connectionMode);

  // When General settings → Toggle Hover Buttons → Connection Labels is Off,
  // the per-label controls (Style / Lock / Delete) stay permanently visible
  // alongside the label, instead of fading in on hover.
  let forceShowControls = $derived(
    vaultStore.project?.settings?.general?.hoverButtons?.connectionLabels === false,
  );

  // Cascade-resolved label styling — per-connection override > board
  // settings > global defaults. Falls through to CSS variables when
  // every layer is unset.
  let resolvedLabel = $derived(
    effectiveConnectionLabelStyle(
      {
        textColor: connection.label.textColor,
        backgroundColor: connection.label.backgroundColor,
        fontSize: connection.label.fontSize,
      },
      vaultStore.project?.settings,
      boardStore.current,
    ),
  );

  let labelOpacity = $derived.by(() => {
    if (connectionsStore.hideAllLabels && !isLabelLocked && !inConnectionMode) return 0;
    if (isLabelHidden && !inConnectionMode) return 0;
    if (isLabelHidden && inConnectionMode) return 0.3;
    return 1;
  });

  // Cycle labelVisibility: visible → hidden → visible-locked → hidden-locked → visible
  function cycleLabelVisibility(e: Event) {
    e.stopPropagation();
    const current: Connection['labelVisibility'] = connection.labelVisibility ?? 'visible';
    const states: Connection['labelVisibility'][] = ['visible', 'hidden', 'visible-locked', 'hidden-locked'];
    const idx = states.indexOf(current);
    const next: Connection['labelVisibility'] = states[(idx + 1) % states.length] ?? 'visible';
    const before: Partial<Connection> = { labelVisibility: current };
    const after: Partial<Connection> = { labelVisibility: next };
    historyStore.execute(new UpdateConnectionCommand(connection.id, before, after));
  }

  // Respond to external "Edit Label" trigger from context menu
  $effect(() => {
    if (editingProp && !isEditing) {
      startEdit();
    }
  });

  function startEdit() {
    if (connection.label.locked) return;
    isEditing = true;
    editText = connection.label.text;
    // Editor is created in $effect once labelEditorElement is bound
  }

  /** The editor's text and HTML, as a commit would save them. */
  function editorLabel(editor: Editor): { text: string; content: string } {
    const rawText = editor.getText();
    // When the user clears the label, TipTap's getHTML() still returns
    // `<p></p>` — truthy, so the {#if connection.label.content} branch
    // wins and renders an empty paragraph instead of the faded "Label"
    // placeholder. Normalise empty text → empty content so the schema
    // state matches "label never set" and the placeholder branch fires.
    const text = rawText.trim() === '' ? '' : rawText;
    return { text, content: text === '' ? '' : editor.getHTML() };
  }

  /** The label being edited, when it differs from the saved one; else null. */
  function uncommittedLabel(): { text: string; content: string } | null {
    if (!isEditing || !labelEditor) return null;
    const next = editorLabel(labelEditor);
    const saved = connection.label;
    if (next.text === saved.text && next.content === (saved.content ?? '')) return null;
    return next;
  }

  function commitEdit() {
    if (labelEditor) {
      const { text, content } = editorLabel(labelEditor);
      destroyLabelEditor();
      isEditing = false;
      const before = { label: { ...connection.label } };
      const after = { label: { ...connection.label, text, content } };
      historyStore.execute(new UpdateConnectionCommand(connection.id, before, after));
    } else {
      isEditing = false;
      const before = { label: { ...connection.label } };
      const text = editText.trim() === '' ? '' : editText;
      const after = { label: { ...connection.label, text, content: text === '' ? '' : connection.label.content } };
      historyStore.execute(new UpdateConnectionCommand(connection.id, before, after));
    }
    oneditdone?.();
  }

  function cancelEdit() {
    destroyLabelEditor();
    isEditing = false;
    oneditdone?.();
  }

  function destroyLabelEditor() {
    if (labelEditor) {
      tiptapToolbar.releaseEditor(labelEditor);
      labelEditor.destroy();
      labelEditor = null;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  }

  // Create the label editor once the element is available
  $effect(() => {
    if (isEditing && labelEditorElement && !labelEditor) {
      const initialContent = connection.label.content || `<p>${connection.label.text}</p>`;
      labelEditor = createLabelEditor({
        element: labelEditorElement,
        content: initialContent,
        onFocus: () => {
          if (labelEditor) tiptapToolbar.setActiveEditor(labelEditor);
        },
        onBlur: () => {
          if (tiptapToolbar.activeEditor === labelEditor) {
            tiptapToolbar.clearActiveEditor();
          }
        },
        onSelectionUpdate: () => tiptapToolbar.syncState(),
        onTransaction: () => tiptapToolbar.syncState(),
      });
      tiptapToolbar.setActiveEditor(labelEditor);
      // Focus at end
      labelEditor.commands.focus('end');
    }
  });

  // Commit the edit when the user clicks anywhere outside the editor
  // host. Without this, `isEditing` sticks to true and the next attempt
  // to edit the label silently no-ops (the editor element is gone but
  // the flag prevents `startEdit` from firing).
  //
  // Whitelist the formatting toolbar and editor-driven popups: pointerdown
  // fires before mousedown, so the toolbar's mousedown-preventDefault focus
  // guard is too late to stop us from committing — we have to skip the
  // commit here instead, otherwise clicking Bold/Italic/Color destroys the
  // editor before the format command can apply.
  $effect(() => {
    if (!isEditing || !labelEditorElement) return;
    const editorEl = labelEditorElement;
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (editorEl.contains(target)) return;
      if (target.closest('.global-toolbar')) return;
      if (target.closest('[data-keeps-editor-focus]')) return;
      commitEdit();
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  });

  // Leaving the vault, quitting and Ctrl+S save a label being edited: the
  // views unmount only in the swap, after the save before leaving.
  $effect(() => registerComponentFlush('connection label', () => {
    if (uncommittedLabel()) commitEdit();
  }));

  // A label still being edited when the view closes (Ctrl+W, a board switch)
  // is saved, not dropped. By then the pane may show another board, so it is
  // written through the cache to the connection's own board (its `boardId`),
  // with no undo step: the active history stack may be another board's.
  onDestroy(() => {
    const pending = uncommittedLabel();
    destroyLabelEditor();
    if (!pending) return;
    boardCacheStore.persistUpdateConnection(connection.id, {
      ...connection,
      label: { ...connection.label, ...pending },
    });
  });

  function handleLabelDragStart(e: PointerEvent) {
    // Pointer-down inside the editor must not start a label-along-path
    // drag — the editor swallows clicks for caret placement and selection.
    if (isEditing) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('.label-editor-host')) return;
    if (connection.label.locked || !pathElement) return;
    e.stopPropagation();
    isDragging = true;
    dragStartPosition = connection.label.position;
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleLabelDragMove(e: PointerEvent) {
    if (!isDragging || !pathElement) return;

    // Find nearest parametric position on the path
    const svgEl = pathElement.ownerSVGElement;
    if (!svgEl) return;

    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;

    const ctm = svgEl.getScreenCTM();
    if (!ctm) return;
    const svgPoint = pt.matrixTransform(ctm.inverse());

    // Sample the path and use segment projection for precise label positioning
    const length = pathElement.getTotalLength();
    const SAMPLES = 60;
    const polylinePoints: PathPoint[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const p = pathElement.getPointAtLength((i / SAMPLES) * length);
      polylinePoints.push({ x: p.x, y: p.y });
    }
    const bestT = getClosestTOnPolyline(polylinePoints, { x: svgPoint.x, y: svgPoint.y });

    boardStore.updateConnection(connection.id, {
      label: { ...connection.label, position: bestT },
    });
  }

  function handleLabelDragEnd() {
    if (isDragging && connection.label.position !== dragStartPosition) {
      const before = { label: { ...connection.label, position: dragStartPosition } };
      const after = { label: { ...connection.label } };
      historyStore.pushWithoutExecute(new UpdateConnectionCommand(connection.id, before, after));
    }
    isDragging = false;
  }

  // The system took the pointer mid-drag: the label goes back where it was
  // and no undo step is left for a move that never finished.
  function handleLabelDragCancel() {
    if (!isDragging) return;
    isDragging = false;
    if (connection.label.position !== dragStartPosition) {
      boardStore.updateConnection(connection.id, {
        label: { ...connection.label, position: dragStartPosition },
      });
    }
  }

  function handleMouseEnter() {
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
    showControls = true;
  }

  function handleMouseLeave() {
    if (isEditing) return;
    hideTimeout = setTimeout(() => { showControls = false; }, 200);
  }

  // Cycle path visibility: visible → hidden → visible-locked → hidden-locked → visible
  function cyclePathVisibility(e: Event) {
    e.stopPropagation();
    const states: Connection['visibility'][] = ['visible', 'hidden', 'visible-locked', 'hidden-locked'];
    const idx = states.indexOf(connection.visibility);
    const next = states[(idx + 1) % states.length];
    const before: Partial<Connection> = { visibility: connection.visibility };
    const after: Partial<Connection> = { visibility: next };
    historyStore.execute(new UpdateConnectionCommand(connection.id, before, after));
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    oncontextmenu?.(e, connection);
  }
</script>

{#if pathElement && (connection.label.text || inConnectionMode || editingProp)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <g
    class="connection-label-group"
    style="opacity: {labelOpacity}; pointer-events: {labelOpacity === 0 ? 'none' : 'auto'}"
    onmouseenter={handleMouseEnter}
    onmouseleave={handleMouseLeave}
    oncontextmenu={handleContextMenu}
  >
    <!-- Label background -->
    <foreignObject
      x={labelPos.x - 60}
      y={isEditing ? labelPos.y - 20 : labelPos.y - 14}
      width="120"
      height={isEditing ? 40 : 28}
      style="overflow: visible; z-index: var(--z-connection-label); pointer-events: auto;"
    >
      <div style="display: flex; justify-content: center;">
      <div
        class="connection-label"
        class:editing={isEditing}
        class:has-text={connection.label.text.length > 0}
        style="color: {resolvedLabel.textColor || 'var(--connection-label-color)'}{resolvedLabel.backgroundColor ? `; background: ${resolvedLabel.backgroundColor}` : ''}{resolvedLabel.fontSize != null ? `; font-size: ${resolvedLabel.fontSize}px` : ''}"
        onpointerdown={handleLabelDragStart}
        onpointermove={handleLabelDragMove}
        onpointerup={handleLabelDragEnd}
        onpointercancel={handleLabelDragCancel}
        ondblclick={() => startEdit()}
      >
        {#if isEditing}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="label-editor-host"
            bind:this={labelEditorElement}
            onkeydown={handleKeydown}
            onclick={(e) => e.stopPropagation()}
          ></div>
        {:else}
          <span class="label-text" title={connection.label.text}>
            {#if connection.label.content}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitizeInlineHtml uses DOMPurify with inline-text allow-list (see lib/utils/sanitizeHtml.ts) -->
              {@html sanitizeInlineHtml(connection.label.content)}
            {:else}
              {connection.label.text || (inConnectionMode ? 'Label' : '')}
            {/if}
          </span>
        {/if}
      </div>
      </div>
    </foreignObject>

    <!-- Path + Label visibility toggles (connection mode only, side by side above controls) -->
    {#if inConnectionMode}
      {@const visibilityLabels = { visible: 'Visible', 'visible-locked': 'Visible (Locked)', hidden: 'Hidden', 'hidden-locked': 'Hidden (Locked)' }}

      <!-- Path visibility toggle -->
      <g
        class="connection-visibility-toggle"
        style="pointer-events: auto;"
        transform="translate({labelPos.x - 20}, {labelPos.y - 62})"
        role="button"
        tabindex="0"
        onclick={cyclePathVisibility}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cyclePathVisibility(e); } }}
      >
        <title>Path: {visibilityLabels[connection.visibility]} — click to cycle</title>
        <rect x="0" y="0" width="16" height="16" rx="3" fill="var(--ui-surface)" stroke="var(--ui-border)" stroke-width="1" />
        {#if isPathHidden}
          <line x1="3" y1="8" x2="13" y2="8" stroke="var(--text-tertiary)" stroke-width="1.5" />
          <line x1="3" y1="3" x2="13" y2="13" stroke="var(--accent-danger)" stroke-width="1.5" />
        {:else}
          <circle cx="8" cy="8" r="3" fill="none" stroke="var(--text-secondary)" stroke-width="1.5" />
          <path d="M2 8 Q8 3 14 8 Q8 13 2 8" fill="none" stroke="var(--text-secondary)" stroke-width="1" />
        {/if}
        {#if connection.visibility.includes('locked')}
          <rect x="10" y="10" width="6" height="6" rx="1" fill="var(--ui-surface)" stroke="var(--accent-warning)" stroke-width="0.8" />
          <path d="M12 12v-1a1 1 0 0 1 2 0v1" fill="none" stroke="var(--accent-warning)" stroke-width="0.6" />
        {/if}
      </g>

      <!-- Label visibility toggle -->
      <g
        class="connection-visibility-toggle"
        style="pointer-events: auto;"
        transform="translate({labelPos.x + 4}, {labelPos.y - 62})"
        role="button"
        tabindex="0"
        onclick={cycleLabelVisibility}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleLabelVisibility(e); } }}
      >
        <title>Label: {visibilityLabels[connection.labelVisibility ?? 'visible']} — click to cycle</title>
        <rect x="0" y="0" width="16" height="16" rx="3" fill="var(--ui-surface)" stroke="var(--ui-border)" stroke-width="1" />
        {#if isLabelHidden}
          <line x1="3" y1="8" x2="13" y2="8" stroke="var(--text-tertiary)" stroke-width="1.5" />
          <line x1="3" y1="3" x2="13" y2="13" stroke="var(--accent-danger)" stroke-width="1.5" />
        {:else}
          <circle cx="8" cy="8" r="3" fill="none" stroke="var(--text-secondary)" stroke-width="1.5" />
          <path d="M2 8 Q8 3 14 8 Q8 13 2 8" fill="none" stroke="var(--text-secondary)" stroke-width="1" />
        {/if}
        {#if (connection.labelVisibility ?? 'visible').includes('locked')}
          <rect x="10" y="10" width="6" height="6" rx="1" fill="var(--ui-surface)" stroke="var(--accent-warning)" stroke-width="0.8" />
          <path d="M12 12v-1a1 1 0 0 1 2 0v1" fill="none" stroke="var(--accent-warning)" stroke-width="0.6" />
        {/if}
      </g>
    {/if}

    <!-- Controls (always visible in connection mode, hover otherwise; forced
         on when the user disables Hover Buttons for Connection Labels). -->
    {#if (inConnectionMode || showControls || forceShowControls) && !isEditing}
      <foreignObject
        x={labelPos.x - 60}
        y={labelPos.y - 44}
        width="120"
        height="28"
        style="overflow: visible; pointer-events: auto;"
      >
        <div style="display: flex; justify-content: center;">
        <div class="label-controls">
          <button
            class="label-ctrl-btn"
            title="Style"
            onclick={(e) => { e.stopPropagation(); onstyleclick?.(e, connection); }}
          >
            <StyleIcon size={12} />
          </button>
          <button
            class="label-ctrl-btn"
            title={connection.label.locked ? 'Unlock' : 'Lock'}
            onclick={(e) => {
              e.stopPropagation();
              const before = { label: { ...connection.label } };
              const after = { label: { ...connection.label, locked: !connection.label.locked } };
              historyStore.execute(new UpdateConnectionCommand(connection.id, before, after));
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              {#if connection.label.locked}
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              {:else}
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>
              {/if}
            </svg>
          </button>
          <button
            class="label-ctrl-btn danger"
            title="Delete Connection"
            aria-label="Delete connection"
            onclick={(e) => {
              e.stopPropagation();
              boardStore.removeConnectionWithHistory(connection.id);
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
        </div>
      </foreignObject>
    {/if}
  </g>
{/if}

<style>
  .label-editor-host {
    width: 100%;
    min-height: 28px;
    font-size: var(--font-size-connection-label, 12px);
    outline: none;
    background: var(--connection-label-bg, var(--ui-surface));
    border: 1px solid var(--connection-label-hover-border, var(--accent-primary));
    border-radius: 3px;
    padding: 2px 4px;
    cursor: text;
    overflow: visible;
  }

  .label-editor-host :global(.label-tiptap) {
    outline: none;
    min-height: 20px;
    white-space: nowrap;
  }

  .label-editor-host :global(.label-tiptap p) {
    margin: 0;
  }
</style>
