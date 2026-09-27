<script lang="ts">
  import StyleIcon from '../shared/StyleIcon.svelte';
  /**
   * Frame — Visual grouping container for tiles on the canvas.
   * Has a header (title, style, collapse, delete), body, drag (moves children),
   * resize, and containment detection.
   */
  import type { Frame as FrameType } from '../../schema/index';
  import type { Editor } from '@tiptap/core';
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { framesStore } from '../../stores/frames.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { confirmRemoveFrame } from '../../lib/frames/confirmRemoveFrame';

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  const boardStore = scope.board;
  const canvasStore = scope.canvas;
  const spatialStore = scope.spatial;
  import { FRAME_DEFAULTS } from '../../constants/defaults';
  import { effectiveFrameStyle } from '../../lib/styles/effectiveStyle';
  import { createLabelEditor } from '../../lib/editor/createEditor';
  import { tiptapToolbar } from '../../lib/editor/toolbarConfig';
  import { sanitizeInlineHtml } from '../../lib/utils/sanitizeHtml';
  import { resolveTitleCommitValues, type ResolvedTitleCommit } from '../../lib/editor/titleCommit';
  import { revertFrameDragOnTeardown } from '../../lib/frames/frameDragCancel';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import FrameStylePopup from './FrameStylePopup.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { registerComponentFlush } from '../../lib/boards/componentFlush';
  import { UpdateFrameCommand, MoveFrameCommand } from '../../commands/index';

  let {
    frame,
    oncontextmenu,
  }: {
    frame: FrameType;
    oncontextmenu?: (e: MouseEvent, frame: FrameType) => void;
  } = $props();

  // Cascade-resolved style, including Dynamic Contrast Text decisions.
  // Empty per-element fields fall through to board / global defaults via
  // `effectiveFrameStyle` — nothing to synthesise.
  let resolved = $derived(
    effectiveFrameStyle(frame, vaultStore.project?.settings, boardStore.current),
  );

  // When General settings → Toggle Hover Buttons → Frames is Off, the header
  // action buttons (Style, Delete) stay permanently visible.
  let forceShowButtons = $derived(
    vaultStore.project?.settings?.general?.hoverButtons?.frames === false,
  );

  let isEditingTitle = $state(false);
  let titleEditorElement = $state<HTMLDivElement | null>(null);
  let titleEditor: Editor | null = $state(null);
  let showStyle = $state(false);
  // Handle for the inline blur→commit defer: stored so teardown/destroy can
  // cancel it and so repeated blur/focus cycles don't stack timers. Cleared by hand in
  // `destroyTitleEditor()` — the `gates:component-timer-cleanup` gate can't see
  // a timer armed inside a TipTap callback.
  let blurCommitTimer: ReturnType<typeof setTimeout> | null = null;

  let titleDisplay = $derived.by(() => {
    const raw = (frame as FrameType & { titleHtml?: string }).titleHtml;
    if (!raw || raw.trim().length === 0) return null;
    return sanitizeInlineHtml(raw);
  });
  let stylePopupX = $state(0);
  let stylePopupY = $state(0);
  let isDragging = $state(false);
  let isResizing = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPosX = 0;
  let dragStartPosY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;

  // Derived from `resolved.shape`. Rounded mirrors the prior hard-coded 6px;
  // Rectangle drops to square corners. Border + bg-image clip both inherit
  // this so the corner radius stays consistent across the three layers.
  let borderRadius = $derived(resolved.shape === 'rounded' ? '6px' : '0px');

  // Resolve the background image to a URL the renderer can load.
  // Web URLs and data URIs pass through. Vault-relative paths can't use
  // file:// from the dev renderer (blocked by Chromium web security when
  // the page itself was loaded from http://), so we read the bytes via
  // the media:read-file IPC and render as a data URL.
  let bgImageUrl = $state('');
  $effect(() => {
    // Read through the cascade so per-board / global Frame defaults can
    // supply a background image when the frame itself has none set.
    const src = frame.style.backgroundImage || resolved.backgroundImage;
    const vaultPath = vaultStore.path;
    if (!src) { bgImageUrl = ''; return; }
    if (src.startsWith('http') || src.startsWith('data:')) {
      bgImageUrl = src;
      return;
    }
    if (!vaultPath) { bgImageUrl = ''; return; }
    let cancelled = false;
    void window.filo.invoke('media:read-file', vaultPath, src).then((res) => {
      if (cancelled) return;
      bgImageUrl = res.success
        ? `data:${res.mimeType};base64,${res.data}`
        : '';
    });
    return () => { cancelled = true; };
  });

  // Cascade-resolved drop shadow. The hover state in CSS layers an accent
  // glow on top of this base shadow; without it the Frame Style popup's
  // "Shadow" slider would have no rest-state effect.
  let frameBoxShadow = $derived(
    resolved.shadowIntensity > 0
      ? `0 2px ${8 * resolved.shadowIntensity}px rgba(0,0,0,${0.3 * resolved.shadowIntensity})`
      : 'none',
  );

  // Compose the cascade-resolved fill colours with the opacity slider into
  // ready-to-paint values. We blend with `transparent` via `color-mix` so
  // text and buttons sitting on top stay fully opaque (using CSS `opacity`
  // on the wrapper would also fade descendants — wrong here).
  //
  // Empty colour → `transparent` outright (the slider becomes a no-op when
  // there's no fill, which matches the "fully transparent default" spec).
  // Border is intentionally NOT faded — it remains the user's signal that
  // a frame is present, even at 0% opacity.
  function withOpacity(color: string, opacity: number): string {
    if (!color) return 'transparent';
    if (opacity >= 0.999) return color;
    if (opacity <= 0.001) return 'transparent';
    const pct = Math.round(opacity * 100);
    return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
  }

  let frameStyle = $derived([
    `left: ${frame.position.x}px`,
    `top: ${frame.position.y}px`,
    `width: ${frame.size.width}px`,
    `height: ${frame.size.height}px`,
    `z-index: var(--z-frame)`,
    `--frame-header-bg: ${withOpacity(resolved.headerColor, resolved.backgroundOpacity)}`,
    `--frame-body-bg: ${withOpacity(resolved.bodyColor, resolved.backgroundOpacity)}`,
    `--frame-bg-opacity: ${resolved.backgroundOpacity}`,
    `--frame-border-color: ${resolved.borderColor || 'var(--ui-border)'}`,
    `border: ${resolved.borderWidth}px ${resolved.borderStyle} ${resolved.borderColor || 'var(--ui-border)'}`,
    `border-radius: ${borderRadius}`,
    // Drives `box-shadow: var(--frame-shadow, none)` in the CSS rule. We
    // don't set `box-shadow` inline because the :hover rule (selected glow)
    // would lose to inline-style specificity — driving the variable lets
    // the hover state combine the cascade shadow with the glow.
    `--frame-shadow: ${frameBoxShadow}`,
    resolved.bodyTextColor ? `color: ${resolved.bodyTextColor}` : '',
  ].filter(Boolean).join('; '));

  // ── Title editing ──
  function startTitleEdit() {
    isEditingTitle = true;
    // Editor mounts in the $effect below once the host div binds.
  }

  function destroyTitleEditor() {
    // Cancel a pending blur→commit defer so it can't fire
    // after the editor is gone (commit/cancel/unmount all route through here).
    if (blurCommitTimer) {
      clearTimeout(blurCommitTimer);
      blurCommitTimer = null;
    }
    if (titleEditor) {
      if (tiptapToolbar.activeEditor === titleEditor) {
        tiptapToolbar.clearActiveEditor();
      }
      titleEditor.destroy();
      titleEditor = null;
    }
  }

  /** Read the live editor BEFORE destroy (mirrors TileHeader). */
  function snapshotEditorTitle(): ResolvedTitleCommit | null {
    if (!titleEditor) return null;
    return resolveTitleCommitValues(titleEditor.getText(), titleEditor.getHTML(), 'Frame');
  }

  /** The editor's value when it differs from the committed title, else null. */
  function uncommittedTitle(): ResolvedTitleCommit | null {
    const snap = snapshotEditorTitle();
    if (!snap) return null;
    const prevHtml = (frame as FrameType & { titleHtml?: string }).titleHtml ?? '';
    return snap.plain !== frame.title || prevHtml !== (snap.titleHtml ?? '') ? snap : null;
  }

  // A save or a leave commits a title typed but not yet committed.
  $effect(() => registerComponentFlush('frame title', () => { if (uncommittedTitle()) commitTitle(); }));

  function commitTitle() {
    const snap = snapshotEditorTitle();
    destroyTitleEditor();
    isEditingTitle = false;
    if (!snap) return;
    applyFrameTitleCommit(snap, false);
  }

  /**
   * Shared by the normal blur/Enter commit and the unmount teardown. A
   * teardown commit writes through the cache (resolves the frame's home board
   * even when the pane has already switched boards) and pushes no history
   * entry — mid-swap the global active stack can't be trusted.
   */
  function applyFrameTitleCommit(snap: ResolvedTitleCommit, fromTeardown: boolean): void {
    const { plain, titleHtml } = snap;
    const prevHtml = (frame as FrameType & { titleHtml?: string }).titleHtml ?? '';
    if (plain === frame.title && prevHtml === (titleHtml ?? '')) return;
    if (fromTeardown) {
      boardCacheStore.persistUpdateFrame(frame.id, {
        ...frame,
        title: plain,
        titleHtml,
        updatedAt: Date.now(),
      } as FrameType);
      return;
    }
    // Undoable. Snapshot the prior title/titleHtml pair
    // so Ctrl+Z restores both even when only one changed.
    historyStore.execute(new UpdateFrameCommand(
      frame.id,
      { title: frame.title, titleHtml: prevHtml || undefined },
      { title: plain, titleHtml } as Partial<FrameType>,
      `Rename frame`,
    ));
  }

  function cancelTitleEdit() {
    destroyTitleEditor();
    // Explicitly blur the host so focus lands somewhere predictable
    // after ProseMirror's destroy tears down its contenteditable child.
    titleEditorElement?.blur();
    isEditingTitle = false;
  }

  function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelTitleEdit(); }
  }

  $effect(() => {
    if (isEditingTitle && titleEditorElement && !titleEditor) {
      const existingHtml = (frame as FrameType & { titleHtml?: string }).titleHtml;
      const initial = existingHtml && existingHtml.trim().length > 0
        ? existingHtml
        : `<p>${escapeForInitial(frame.title)}</p>`;
      titleEditor = createLabelEditor({
        element: titleEditorElement,
        content: initial,
        onFocus: () => {
          if (titleEditor) tiptapToolbar.setActiveEditor(titleEditor);
        },
        onBlur: () => {
          // Slight delay so toolbar-button clicks (which blur the editor)
          // don't trigger a premature commit. Store the handle (and clear any
          // prior one) so a teardown inside the window can commit-not-drop;
          // null it once it fires.
          if (blurCommitTimer) clearTimeout(blurCommitTimer);
          blurCommitTimer = setTimeout(() => {
            blurCommitTimer = null;
            if (titleEditor && tiptapToolbar.activeEditor !== titleEditor) {
              commitTitle();
            }
          }, 200);
        },
        onTransaction: () => {
          if (titleEditor && tiptapToolbar.activeEditor === titleEditor) {
            tiptapToolbar.syncState();
          }
        },
      });
      queueMicrotask(() => {
        titleEditor?.commands.focus('end');
        titleEditor?.commands.selectAll();
      });
    }
  });

  // Commit-on-unmount: a title typed but not committed (the 200 ms blur
  // window still open, or the view closed while editing) is committed rather
  // than dropped. Snapshot before the editor is destroyed,
  // clear the timer (inline so `gates:component-timer-cleanup` recognises it),
  // then commit through the teardown-safe path.
  $effect(() => {
    return () => {
      const snap = uncommittedTitle();
      if (blurCommitTimer) clearTimeout(blurCommitTimer);
      blurCommitTimer = null;
      destroyTitleEditor();
      if (snap) applyFrameTitleCommit(snap, true);
    };
  });

  function escapeForInitial(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Collapse ──
  function toggleCollapse() {
    // Undoable.
    historyStore.execute(new UpdateFrameCommand(
      frame.id,
      { collapsed: frame.collapsed },
      { collapsed: !frame.collapsed },
      frame.collapsed ? 'Expand frame' : 'Collapse frame',
    ));
  }

  // ── Delete ──
  // Frame delete keeps contained tiles in place (design doc line 852).
  // Gated by a ConfirmDialog so a stray click on the
  // trash icon (which sits in the hover-revealed header chrome) can't
  // silently rip out a frame. Helper builds the openConfirm config so
  // the wiring is testable without mounting the component.
  function deleteFrame() {
    confirmRemoveFrame({
      tileCount: frame.tileIds.length,
      openConfirm: uiStore.openConfirm,
      onConfirmed: () => boardStore.removeFrameWithHistory(frame.id),
    });
  }

  // ── Drag ──
  // Snapshot the tile IDs the frame contained at drag start so the undo
  // command moves the same set back even if `framesStore.updateContainment`
  // fires for an unrelated tile mid-drag.
  //
  // The move handler is RAF-throttled: every raw pointermove (60–120/s) would
  // otherwise run a frame write + N tile writes + N spatial index updates.
  // The delta is computed from the anchored start position and the running
  // pointer event, not from `frame.position` after `updateFrame`, so it
  // doesn't depend on the cache↔active proxy bridge. Reference: tileDrag.ts.
  let dragContainedTileIds: string[] = [];
  let dragRafPending = false;
  let dragLatestEvent: PointerEvent | null = null;
  // Board the frame belonged to when the drag began. The
  // unmount-mid-drag teardown needs it to route its revert through the cache
  // when the pane's scope has already switched boards.
  let dragHomeBoardId: string | null = null;
  // Local mirror of the last frame position the RAF wrote, used to compute
  // the per-RAF tile delta without depending on the cache↔active proxy
  // bridge staying stale across the `boardStore.updateFrame` call.
  let lastFrameX = 0;
  let lastFrameY = 0;

  function handleDragStart(e: PointerEvent) {
    if (isEditingTitle) return;
    e.stopPropagation();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPosX = frame.position.x;
    dragStartPosY = frame.position.y;
    lastFrameX = frame.position.x;
    lastFrameY = frame.position.y;
    // Only unlocked tiles travel with the frame (`moveContainedTiles` skips
    // locked ones), so only they belong in the undo set.
    dragContainedTileIds = frame.tileIds.filter((id) => boardStore.getTile(id)?.locked !== true);
    dragHomeBoardId = boardStore.current?.id ?? null;
    // Batch the spatial revision bumps from each contained-tile move so
    // the viewport-culling consumers only re-derive once per RAF, not once
    // per dragged tile per frame.
    spatialStore.beginBatch();
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleDragMove(e: PointerEvent) {
    if (!isDragging) return;
    dragLatestEvent = e;
    if (dragRafPending) return;
    dragRafPending = true;
    requestAnimationFrame(flushDragMove);
  }

  function flushDragMove() {
    dragRafPending = false;
    const e = dragLatestEvent;
    dragLatestEvent = null;
    if (!isDragging || !e) return;

    const scale = canvasStore.scale || 1;
    const dx = (e.clientX - dragStartX) / scale;
    const dy = (e.clientY - dragStartY) / scale;

    const newX = dragStartPosX + dx;
    const newY = dragStartPosY + dy;

    // Track the incremental delta this RAF relative to the previous one
    // so contained tiles move by the same step the frame moved by. We
    // anchor against a local `lastFrameX/Y` rather than `frame.position.x`
    // so the computation no longer depends on the cache↔active proxy
    // staying stale across the `updateFrame` write (folded-in C.8 fix).
    const tileDx = newX - lastFrameX;
    const tileDy = newY - lastFrameY;
    lastFrameX = newX;
    lastFrameY = newY;

    // Move frame.
    boardStore.updateFrame(frame.id, { position: { x: newX, y: newY } });

    // Move contained tiles with the frame.
    if (Math.abs(tileDx) > 0.01 || Math.abs(tileDy) > 0.01) {
      framesStore.moveContainedTiles(frame.id, tileDx, tileDy);
    }
  }

  function handleDragEnd() {
    if (!isDragging) return;
    // Flush any RAF-pending move synchronously so the final position lands
    // on disk + history without waiting for the next animation frame.
    // Flush BEFORE flipping the flag: `flushDragMove`'s first guard is
    // `if (!isDragging) return`, so flipping first would drop the pointer
    // motion since the last RAF tick.
    if (dragRafPending && dragLatestEvent) {
      flushDragMove();
    }
    isDragging = false;
    dragLatestEvent = null;
    dragRafPending = false;
    spatialStore.endBatch();
    // Record the drag as a single undoable command. The
    // live position was already written incrementally in handleDragMove,
    // so pushWithoutExecute records the diff without re-running the
    // write. Skip if the net delta is zero (jitter / aborted drag).
    //
    // Use `lastFrameX/Y` (the value we last wrote via updateFrame) rather
    // than the prop `frame.position.x/y` — the prop is read directly from
    // the active proxy, but its propagation back to this component is
    // asynchronous, so reading it here can lag the drag by up to one
    // animation frame. `lastFrameX/Y` is the canonical "where we put the
    // frame" mirror.
    if (lastFrameX !== dragStartPosX || lastFrameY !== dragStartPosY) {
      historyStore.pushWithoutExecute(new MoveFrameCommand(
        frame.id,
        { x: dragStartPosX, y: dragStartPosY },
        { x: lastFrameX, y: lastFrameY },
        dragContainedTileIds,
      ));
    }
    framesStore.updateContainment(frame.id);
  }

  // ── Resize ──
  function handleResizeStart(e: PointerEvent) {
    e.stopPropagation();
    isResizing = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    resizeStartW = frame.size.width;
    resizeStartH = frame.size.height;
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handleResizeMove(e: PointerEvent) {
    if (!isResizing) return;

    const scale = canvasStore.scale || 1;
    const dx = (e.clientX - dragStartX) / scale;
    const dy = (e.clientY - dragStartY) / (scale || 1);

    const newW = Math.max(FRAME_DEFAULTS.minWidth, resizeStartW + dx);
    const newH = Math.max(FRAME_DEFAULTS.minHeight, resizeStartH + dy);

    boardStore.updateFrame(frame.id, { size: { width: newW, height: newH } });
  }

  // pointercancel / lostpointercapture teardown. Without it a native
  // pointercancel mid-drag (touch/pen OS gesture, browser fullscreen) leaves
  // `spatialStore.beginBatch()` open forever (viewport-culled rendering stops
  // updating) and `isDragging` stuck true (the next hover moves the frame
  // with NO undo command). Route both cancel signals through the same end
  // handlers — they're idempotent (`if (!isDragging/!isResizing) return`), so
  // the lostpointercapture that follows every normal pointerup is a no-op.
  // Commit-current semantics (not tileDrag's snap-back): the incremental
  // `updateFrame` writes already landed, so ending the drag records the
  // command for what's on screen rather than silently reverting it.
  function handleDragCancel() {
    handleDragEnd();
  }

  function handleResizeCancel() {
    handleResizeEnd();
  }

  // Unmount mid-drag (frame deleted by an external reload / board switch while
  // dragging) must close the spatial batch (or viewport culling stays frozen)
  // AND truly CANCEL the drag: the move was written incrementally per RAF and
  // only handleDragEnd pushes MoveFrameCommand, so leaving the positions in
  // place would persist a move with NO undo entry. Mirror tileDrag's destroy(): revert the frame and the captured contained
  // tiles to their drag-start positions ("a half-committed move would
  // corrupt undo"). No history push from a teardown $effect — mid-board-swap
  // the global active stack can't be trusted. Cleanup-only $effect (no
  // reactive reads in setup), matching the title-editor teardown above.
  $effect(() => () => {
    if (isDragging) {
      isDragging = false;
      dragRafPending = false;
      dragLatestEvent = null;
      const homeBoardId = dragHomeBoardId;
      revertFrameDragOnTeardown(
        {
          frameId: frame.id,
          startX: dragStartPosX,
          startY: dragStartPosY,
          lastX: lastFrameX,
          lastY: lastFrameY,
          containedTileIds: dragContainedTileIds,
        },
        {
          // Dual-route: the pane's scope stores while the board is still
          // active (keeps the spatial index in sync), else the cache keyed
          // by the home board captured at drag start.
          updateFramePosition: (id, position) => {
            if (boardStore.frames.some((f) => f.id === id)) {
              boardStore.updateFrame(id, { position });
            } else {
              boardCacheStore.persistUpdateFrame(id, {
                ...frame,
                position,
                updatedAt: Date.now(),
              } as FrameType);
            }
          },
          getTile: (id) =>
            boardStore.getTile(id)
              ?? (homeBoardId
                ? boardCacheStore.getFullTilesForBoard(homeBoardId)[id]
                : undefined),
          moveTile: (id, position) => {
            if (boardStore.getTile(id)) boardStore.updateTile(id, { position });
            else if (homeBoardId) boardCacheStore.persistUpdateTile(id, { position }, homeBoardId);
          },
        },
      );
      spatialStore.endBatch();
    }
  });

  function handleResizeEnd() {
    if (!isResizing) return;
    isResizing = false;
    // Record the resize as a single undoable command.
    if (frame.size.width !== resizeStartW || frame.size.height !== resizeStartH) {
      historyStore.pushWithoutExecute(new UpdateFrameCommand(
        frame.id,
        { size: { width: resizeStartW, height: resizeStartH } },
        { size: { width: frame.size.width, height: frame.size.height } },
        'Resize frame',
      ));
    }
    framesStore.updateContainment(frame.id);
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    oncontextmenu?.(e, frame);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="frame-container"
  class:collapsed={frame.collapsed}
  class:dragging={isDragging}
  class:force-show-buttons={forceShowButtons}
  style={frameStyle}
  oncontextmenu={handleContextMenu}
>
  <!-- Background image fills the entire frame (sits behind header + body).
       The Frame Opacity slider fades the image together with the header
       and body fills (which are blended via color-mix in `frameStyle`), so
       the whole frame chrome scales as one. Border + title text stay
       opaque so the frame remains findable.
       Wait for the IPC-loaded data URL before rendering to avoid a flash
       of empty background. -->
  {#if bgImageUrl}
    <div
      class="frame-bg-image"
      style="background-image: url('{bgImageUrl}'); opacity: {resolved.backgroundOpacity}"
    ></div>
  {/if}

  <!-- Header. Background reads through `--frame-header-bg` (which already has
       opacity baked in via color-mix) so the slider fades the header fill
       together with the body fill, while title text + buttons stay opaque. -->
  <div
    class="frame-header"
    style="background: var(--frame-header-bg);{resolved.headerTextColor ? ` --header-text-color: ${resolved.headerTextColor};` : ''}"
    onpointerdown={handleDragStart}
    onpointermove={handleDragMove}
    onpointerup={handleDragEnd}
    onpointercancel={handleDragCancel}
    onlostpointercapture={handleDragCancel}
  >
    <div class="frame-header-left">
      <!-- Collapse button -->
      <button class="frame-btn" title={frame.collapsed ? 'Expand' : 'Collapse'} aria-label={frame.collapsed ? 'Expand frame' : 'Collapse frame'} aria-expanded={!frame.collapsed} onclick={(e) => { e.stopPropagation(); toggleCollapse(); }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {#if frame.collapsed}
            <polyline points="9 18 15 12 9 6"/>
          {:else}
            <polyline points="6 9 12 15 18 9"/>
          {/if}
        </svg>
      </button>

      {#if frame.collapsed}
        <span
          class="frame-tile-count"
          title={`${frame.tileIds.length} tile${frame.tileIds.length === 1 ? '' : 's'} hidden`}
          aria-label={`${frame.tileIds.length} tile${frame.tileIds.length === 1 ? '' : 's'} hidden`}
        >{frame.tileIds.length}</span>
      {/if}

      <!-- Title -->
      {#if isEditingTitle}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="frame-title-editor"
          style={resolved.fontSizeTitle != null ? `font-size: ${resolved.fontSizeTitle}px;` : ''}
          bind:this={titleEditorElement}
          onkeydown={handleTitleKeydown}
          onclick={(e) => e.stopPropagation()}
          onpointerdown={(e) => e.stopPropagation()}
        ></div>
      {:else if titleDisplay}
        <span
          class="frame-title"
          style={resolved.fontSizeTitle != null ? `font-size: ${resolved.fontSizeTitle}px;` : ''}
          tabindex="0"
          role="button"
          aria-label="Frame title: {frame.title}. Press F2 or Enter to edit."
          ondblclick={(e) => { e.stopPropagation(); startTitleEdit(); }}
          onkeydown={(e) => { if (e.key === 'F2' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); startTitleEdit(); } }}
        >{@html titleDisplay /* eslint-disable-line svelte/no-at-html-tags -- titleDisplay is sanitized via sanitizeInlineHtml (DOMPurify) in the $derived above */}</span>
      {:else}
        <span
          class="frame-title"
          style={resolved.fontSizeTitle != null ? `font-size: ${resolved.fontSizeTitle}px;` : ''}
          tabindex="0"
          role="button"
          aria-label="Frame title: {frame.title}. Press F2 or Enter to edit."
          ondblclick={(e) => { e.stopPropagation(); startTitleEdit(); }}
          onkeydown={(e) => { if (e.key === 'F2' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); startTitleEdit(); } }}
        >
          {frame.title}
        </span>
      {/if}
    </div>

    <div class="frame-header-right">
      <!-- Style button -->
      <button class="frame-btn" title="Style" aria-label="Frame style options" onclick={(e) => {
        e.stopPropagation();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        stylePopupX = rect.left;
        stylePopupY = rect.bottom + 4;
        showStyle = !showStyle;
      }}>
        <StyleIcon size={14} />
      </button>

      <!-- Delete button -->
      <button class="frame-btn danger" title="Delete Frame" aria-label="Delete frame" onclick={(e) => { e.stopPropagation(); deleteFrame(); }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  </div>

  <!-- Body (animated collapse). Background reads through `--frame-body-bg`
       so the opacity slider fades the whole frame chrome (body + header +
       image) together. Default empty colour resolves to `transparent`, so
       a brand-new frame is fully see-through with only the border + title
       text painted. -->
  <div
    class="frame-body"
    class:body-collapsed={frame.collapsed}
    style="background: var(--frame-body-bg);"
  ></div>

  <!-- Resize handle (hidden when collapsed) -->
  {#if !frame.collapsed}
    <div
      class="frame-resize-handle"
      onpointerdown={handleResizeStart}
      onpointermove={handleResizeMove}
      onpointerup={handleResizeEnd}
      onpointercancel={handleResizeCancel}
      onlostpointercapture={handleResizeCancel}
    ></div>
  {/if}
</div>

{#if showStyle}
  <FrameStylePopup
    {frame}
    x={stylePopupX}
    y={stylePopupY}
    onclose={() => showStyle = false}
  />
{/if}

<style>
  .frame-container {
    position: absolute;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: box-shadow 0.2s ease;
    /* `--frame-shadow` is set inline by the cascade-resolved frame style;
       defaults to `none` so a frame with shadowIntensity=0 has no shadow. */
    box-shadow: var(--frame-shadow, none);
  }

  .frame-container.collapsed {
    height: auto !important;
  }

  .frame-container:hover {
    box-shadow:
      0 0 0 2px var(--frame-selected-glow, var(--accent-primary)),
      var(--ui-shadow),
      var(--frame-shadow, none);
  }

  .frame-container.dragging {
    opacity: 0.85;
  }

  /* Header — sits above the background image so the title and controls
     stay legible regardless of image opacity. Top corners inherit from the
     parent's shape-driven border-radius; bottom corners stay flush so the
     header sits cleanly against the body. */
  .frame-header {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    cursor: grab;
    border-top-left-radius: inherit;
    border-top-right-radius: inherit;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    min-height: 32px;
    gap: 8px;
    user-select: none;
  }

  .frame-header:active {
    cursor: grabbing;
  }

  .collapsed .frame-header {
    border-radius: inherit;
  }

  .frame-header-left {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .frame-header-right {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .frame-container:hover .frame-header-right {
    opacity: 1;
  }

  .frame-title {
    font-size: var(--font-size-frame-title, 15px);
    font-weight: 600;
    color: var(--header-text-color, var(--frame-header-text, var(--text-primary)));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .frame-title-editor {
    font-size: var(--font-size-frame-title, 15px);
    font-weight: 600;
    color: var(--header-text-color, var(--frame-header-text, var(--text-primary)));
    background: var(--frame-header-btn-hover-bg, var(--ui-surface-hover));
    border: 1px solid var(--frame-header-btn-hover-border, var(--ui-border-focus));
    border-radius: 4px;
    padding: 1px 6px;
    outline: none;
    width: 100%;
    min-height: 18px;
  }
  .frame-title-editor :global(.ProseMirror) {
    outline: none;
    min-height: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .frame-title-editor :global(.ProseMirror p) {
    margin: 0;
  }
  .frame-title :global(p) {
    margin: 0;
    display: inline;
  }

  .frame-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--header-text-color, var(--frame-header-text-muted, var(--text-secondary)));
    opacity: 0.75;
    transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
  }

  .frame-tile-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    color: var(--header-text-color, var(--frame-header-text-muted, var(--text-secondary)));
    background: color-mix(in srgb, currentColor 16%, transparent);
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
    cursor: help;
  }

  .frame-btn:hover {
    background: var(--frame-header-btn-hover-bg, var(--ui-surface-hover));
    opacity: 1;
  }

  .frame-btn.danger:hover {
    color: var(--frame-header-btn-danger, var(--accent-danger));
    background: var(--frame-header-btn-danger-bg, var(--menu-danger-bg));
    opacity: 1;
  }

  /* Body */
  .frame-body {
    flex: 1;
    position: relative;
    min-height: 0;
    pointer-events: none;
    /* Bottom corner radius inherits from the parent so Shape: Rectangle gets
       square corners. `inherit` on a shorthand is invalid; using the longhand
       per-corner properties keeps top corners clamped to 0 (under the header). */
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    border-bottom-left-radius: inherit;
    border-bottom-right-radius: inherit;
    transition: opacity 0.2s ease, transform 0.2s ease;
    transform-origin: top;
  }

  .frame-body.body-collapsed {
    opacity: 0;
    transform: scaleY(0);
    height: 0;
    flex: 0;
    overflow: hidden;
  }

  .frame-bg-image {
    position: absolute;
    inset: 0;
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    /* Inherit the frame's shape so Rectangle/Rounded apply uniformly. */
    border-radius: inherit;
    pointer-events: none;
    /* Sit above the body's solid colour but below header text and tiles. */
    z-index: 1;
  }

  /* Resize handle */
  .frame-resize-handle {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 16px;
    height: 16px;
    cursor: se-resize;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .frame-resize-handle::after {
    content: '';
    position: absolute;
    bottom: 3px;
    right: 3px;
    width: 10px;
    height: 10px;
    border-right: 2px solid var(--frame-resize-handle, var(--text-tertiary));
    border-bottom: 2px solid var(--frame-resize-handle, var(--text-tertiary));
    border-radius: 0 0 3px 0;
  }

  .frame-container:hover .frame-resize-handle {
    opacity: 1;
  }

  /* When General settings → Toggle Hover Buttons → Frames is Off, the
     header action buttons stay permanently visible. Resize handle remains
     hover-only because it is not an action button. */
  .frame-container.force-show-buttons .frame-header-right {
    opacity: 1;
  }
</style>
