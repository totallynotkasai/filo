<script lang="ts">
  /**
   * MindMapBoard — Infinite canvas board with pan/zoom, background patterns,
   * tile rendering, connections, frames, selection box, context menu, and semantic zoom.
   */
  import BoardBackground from '../canvas/BoardBackground.svelte';
  import Minimap from '../canvas/Minimap.svelte';
  import SideToolbar from './SideToolbar.svelte';
  import ConnectionLayer from '../connections/ConnectionLayer.svelte';
  import FrameComponent from '../frames/Frame.svelte';
  import WaypointMarker from '../canvas/WaypointMarker.svelte';
  import MindMapPopups from './MindMapPopups.svelte';
  import { getContext } from 'svelte';
  import { BOARD_SCOPE_KEY, isActiveScope, type BoardScope } from '../../lib/boards/boardScope.svelte';
  import { connectionsStore } from '../../stores/connections.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { TILE_DEFAULTS, FRAME_DEFAULTS, defaultTileStyleSnapshot, defaultFrameStyleSnapshot } from '../../constants/defaults';
  import { screenToCanvas } from '../../lib/canvas/coordinates';

  // Pull board / canvas / selection / spatial from the pane's scope (set in
  // PaneView via setContext). Aliases preserve the existing `boardStore.*`
  // call sites throughout this component while routing reads to this pane's
  // scope — so two panes can show different boards independently.
  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);
  // BoardRouter passes every board the pane's `tabId`. This board
  // is pane-correct via BoardScope, so it declares + ignores it (silences Svelte's
  // dev-mode "unknown prop" warning).
  let { tabId: _tabId }: { tabId?: string } = $props();
  const boardStore = scope.board;
  const canvasStore = scope.canvas;
  const selectionStore = scope.selection;
  const spatialStore = scope.spatial;
  import { viewportAction } from '../../lib/canvas/gestures';
  import { dragDropAction } from '../../lib/canvas/dragDrop';
  import { edgePanAction, syncConnectionEdgePan } from '../../lib/canvas/edgePan';
  import { createId } from '../../lib/utils/ids';
  import { historyStore } from '../../stores/history.svelte';
  import { DeleteTilesCommand, MoveTilesCommand, UpdateFrameCommand } from '../../commands/index';
  import { isEditableTextTarget } from '../../lib/utils/editableTarget';
  import { templatesStore } from '../../stores/templates.svelte';
  import { hitTestFrame } from '../../lib/mindmap/frameHitTest';
  import {
    buildTileContextMenu,
    buildFrameContextMenu,
    buildCanvasContextMenu,
  } from '../../lib/mindmap/mindMapContextMenus';
  import {
    findNeighborTile,
    isArrowConsumingTarget,
    isArrowKey,
  } from '../../lib/mindmap/mindMapKeyboard';
  import { VisibleTilesViewModel } from '../../lib/mindmap/visibleTilesViewModel.svelte';
  import { MarqueeSelectionController } from '../../lib/mindmap/marqueeSelectionController.svelte';
  import { confirmRemoveFrame } from '../../lib/frames/confirmRemoveFrame';
  import { createSelectionActions } from '../../lib/mindmap/selectionActions';
  import type { Frame } from '../../schema/index';

  import SmartGuides from '../canvas/SmartGuides.svelte';

  import TileContainer from '../tiles/TileContainer.svelte';
  import TextTile from '../tiles/TextTile.svelte';
  import ImageTile from '../tiles/ImageTile.svelte';
  import VideoTile from '../tiles/VideoTile.svelte';
  import FileTile from '../tiles/FileTile.svelte';
  import AudioTile from '../tiles/AudioTile.svelte';
  import LinkTile from '../tiles/LinkTile.svelte';
  import IframeTile from '../tiles/IframeTile.svelte';

  import TimerTile from '../tiles/TimerTile.svelte';

  let canvasContainer: HTMLElement;

  const marquee = new MarqueeSelectionController({
    canvas: canvasStore,
    selection: selectionStore,
    spatial: spatialStore,
  });
  $effect(() => { marquee.setContainer(canvasContainer ?? null); });

  // Track Shift to expose a crosshair cursor on the canvas — a passive
  // discoverability cue for box-select (shift+drag) without needing the
  // user to start dragging first. Listener cleanup happens via $effect's
  // return value.
  $effect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Shift') marquee.setShiftPressed(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'Shift') marquee.setShiftPressed(false);
    }
    function onBlur() { marquee.setShiftPressed(false); }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  });

  let popups: MindMapPopups | undefined = $state();

  // Listen for tile header button popup events (bubble up from TileHeader)
  $effect(() => {
    if (!canvasContainer) return;
    function handleStylePopup(e: Event) {
      const detail = (e as CustomEvent).detail;
      popups?.openTileStyle(detail.tile, detail.x, detail.y);
    }
    function handleTagEditor(e: Event) {
      const detail = (e as CustomEvent).detail;
      popups?.openTagEditor({ tileId: detail.tileId, x: detail.x, y: detail.y });
    }
    canvasContainer.addEventListener('tile-style-popup', handleStylePopup);
    canvasContainer.addEventListener('tile-tag-editor', handleTagEditor);
    return () => {
      canvasContainer.removeEventListener('tile-style-popup', handleStylePopup);
      canvasContainer.removeEventListener('tile-tag-editor', handleTagEditor);
    };
  });

  // ── Edge-pan during connection drawing ──
  // `connectionsStore.drawing` is GLOBAL, so in split view BOTH panes' effects
  // fire on its transition and the module-singleton edge-pan is first-caller-
  // wins. Gate on this pane being the active one so only the pane the user is
  // drawing in arms edge-pan (the draw's pointerdown activates its pane first
  // via PaneView's capture handler) — otherwise the wrong pane's scope is
  // pinned and edge-pan scrolls the wrong canvas.
  $effect(() => {
    syncConnectionEdgePan(canvasStore, !!connectionsStore.drawing, isActiveScope(scope));
  });

  const viewModel = new VisibleTilesViewModel({
    board: boardStore,
    canvas: canvasStore,
    spatial: spatialStore,
  });

  function createTileAtViewportCenter(): void {
    if (!boardStore.current) return;
    const viewportCenter = {
      x: canvasStore.viewportWidth / 2,
      y: canvasStore.viewportHeight / 2,
    };
    const canvasPos = screenToCanvas(viewportCenter.x, viewportCenter.y, canvasStore.transform);
    const now = Date.now();
    boardStore.addTileWithHistory({
      id: createId(),
      type: 'text',
      title: boardStore.getNextTileName(),
      position: {
        x: canvasPos.x - TILE_DEFAULTS.width / 2,
        y: canvasPos.y - TILE_DEFAULTS.height / 2,
      },
      size: { width: TILE_DEFAULTS.width, height: TILE_DEFAULTS.height },
      style: defaultTileStyleSnapshot(),
      locked: false,
      faded: false,
      tags: [],
      boardId: boardStore.current.id,
      content: '',
      createdAt: now,
      updatedAt: now,
    });
  }

  // Connection mode
  let inConnectionMode = $derived(connectionsStore.connectionMode);

  // Transform style
  let transformStyle = $derived(
    `transform: translate(${canvasStore.x}px, ${canvasStore.y}px) scale(${canvasStore.scale}); transform-origin: 0 0;`,
  );

  // Read scope canvas scalars into explicit $derived locals
  // before passing them to BoardBackground. Inline `scale={canvasStore.scale}`
  // template reads ought to be reactive in Svelte 5, but observed reports
  // suggest the prop value doesn't always re-flow on zoom for non-DOM-bound
  // scalar reads. Wrapping in $derived pins the dependency to the parent's
  // render cycle and guarantees re-pass on every transform change.
  let bgPanX = $derived(canvasStore.x);
  let bgPanY = $derived(canvasStore.y);
  let bgScale = $derived(canvasStore.scale);

  // ── Resize observer to track viewport size ──
  $effect(() => {
    if (!canvasContainer) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        canvasStore.setViewportSize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(canvasContainer);

    return () => observer.disconnect();
  });

  // Tile menu, and canvas menu with 2+ selected.
  const selectionActions = createSelectionActions({
    board: boardStore,
    selection: selectionStore,
    vaultPath: () => (vaultStore.project === null ? null : vaultStore.path),
    openTileStyle: (tile, x, y, tileIds) => popups?.openTileStyle(tile, x, y, tileIds),
    openTagEditor: (args) => popups?.openTagEditor(args),
  });

  // ── Context menu ──
  function handleContextMenu(e: MouseEvent) {
    // Defer to the browser's native menu (spell-check suggestions, etc.)
    // when the right-click landed inside an editable text element.
    if (isEditableTextTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = canvasContainer.getBoundingClientRect();
    const canvasPos = screenToCanvas(e.clientX - rect.left, e.clientY - rect.top, canvasStore.transform);

    const hitIds = spatialStore.queryViewport({
      left: canvasPos.x,
      top: canvasPos.y,
      right: canvasPos.x + 1,
      bottom: canvasPos.y + 1,
    });

    if (hitIds.length > 0) {
      const tileId = hitIds[hitIds.length - 1];
      if (tileId === undefined) return; // hitIds non-empty (checked above)
      if (!selectionStore.isSelected(tileId)) {
        selectionStore.select(tileId);
      }
      const items = buildTileContextMenu({
        selectedCount: selectionStore.selectedIds.size,
        hasBrokenTiles: false,
        brokenCount: 0,
        onStyle: () => selectionActions.openStyle(tileId, e.clientX, e.clientY),
        onTags: () => selectionActions.openTags(e.clientX, e.clientY),
        onSaveTemplate: () => uiStore.openModal('save-template'),
        // The right-clicked tile is always selected (above), so this covers it.
        onToggleLock: selectionActions.toggleLock,
        onDelete: selectionActions.confirmDelete,
      });
      uiStore.showContextMenu(e.clientX, e.clientY, items, tileId);
      return;
    }

    const hitFrame = hitTestFrame(canvasPos.x, canvasPos.y, boardStore.frames);
    if (hitFrame) {
      showFrameContextMenu(e, hitFrame);
      return;
    }

    // Canvas context menu
    const brokenSet = boardStore.current
      ? boardStore.brokenTilesByBoard[boardStore.current.id]
      : undefined;
    const brokenTileIds = brokenSet ? Array.from(brokenSet) : [];
    const brokenCount = brokenTileIds.length;
    const selectedIds = selectionActions.tileIds();
    const items = buildCanvasContextMenu({
      selection: selectedIds.length > 1
        ? {
            count: selectedIds.length,
            anyUnlocked: selectedIds.some((id) => !boardStore.getTile(id)?.locked),
            onToggleLock: selectionActions.toggleLock,
            onTags: () => selectionActions.openTags(e.clientX, e.clientY),
            onStyle: () => selectionActions.openStyle(null, e.clientX, e.clientY),
            onDelete: selectionActions.confirmDelete,
          }
        : undefined,
      brokenCount,
      onNewTile: () => {
        const now = Date.now();
        boardStore.addTileWithHistory({
          id: createId(),
          type: 'text',
          title: boardStore.getNextTileName(),
          position: { x: canvasPos.x, y: canvasPos.y },
          size: { width: TILE_DEFAULTS.width, height: TILE_DEFAULTS.height },
          style: defaultTileStyleSnapshot(),
          locked: false,
          faded: false,
          tags: [],
          boardId: boardStore.current?.id ?? '',
              content: '',
          createdAt: now,
          updatedAt: now,
        });
      },
      onNewFrame: () => {
        const now = Date.now();
        boardStore.addFrameWithHistory({
          id: createId(),
          boardId: boardStore.current?.id ?? '',
          title: 'Frame',
          position: { x: canvasPos.x, y: canvasPos.y },
          size: { width: FRAME_DEFAULTS.width, height: FRAME_DEFAULTS.height },
          style: defaultFrameStyleSnapshot(),
          collapsed: false,
          tileIds: [],
          createdAt: now,
          updatedAt: now,
        });
      },
      onInsertTemplate: () => {
        templatesStore.setPendingInsertAnchor({ x: canvasPos.x, y: canvasPos.y });
        uiStore.openModal('template-picker');
      },
      onSaveWaypoint: () => {
        if (!boardStore.current) return;
        const existing = boardStore.waypoints;
        const name = `Waypoint ${existing.length + 1}`;
        boardStore.addWaypointWithHistory({
          id: createId(),
          name,
          x: canvasPos.x,
          y: canvasPos.y,
          zoom: canvasStore.scale,
        });
        canvasStore.setWaypointsVisible(true);
        uiStore.toast(`Waypoint "${name}" saved`, 'success', 1500);
      },
      onSelectAll: () => {
        selectionStore.selectMultiple(Object.values(boardStore.tiles).map((t) => t.id));
      },
      onOrphanCatcher: () => uiStore.openModal('orphan-catcher'),
      onRemoveBroken: brokenCount > 0 ? () => {
        const boardId = boardStore.current?.id;
        if (!boardId) return;
        // Make broken-tile removal undoable. Construct the
        // DeleteTilesCommand BEFORE removing (so its constructor snapshots
        // placements + connections), then call removeBrokenTiles, then
        // pushWithoutExecute (the live mutation has already happened). The
        // broken-ref registry rebuilds from `knownVaultPaths` on the next
        // recompute pass, so the tracker self-heals after undo.
        const cmd = new DeleteTilesCommand(brokenTileIds);
        const removed = boardStore.removeBrokenTiles(boardId);
        if (removed.length === 0) return;
        historyStore.pushWithoutExecute(cmd);
        uiStore.toast(`Removed ${removed.length} broken tile${removed.length === 1 ? '' : 's'}`, 'success', 2000);
      } : undefined,
    });
    uiStore.showContextMenu(e.clientX, e.clientY, items);
  }

  // ── Frame context menu ──
  function showFrameContextMenu(e: MouseEvent, frame: Frame) {
    const items = buildFrameContextMenu({
      frame,
      onStyle: () => { popups?.openFrameStyle(frame, e.clientX, e.clientY); },
      onToggleCollapse: () => {
        // Route through UpdateFrameCommand so Ctrl+Z reverses
        // the collapse. The command snapshots the prior `collapsed` flag as
        // the inverse patch.
        const prevCollapsed = frame.collapsed;
        historyStore.execute(
          new UpdateFrameCommand(
            frame.id,
            { collapsed: prevCollapsed },
            { collapsed: !prevCollapsed },
            prevCollapsed ? 'Expand frame' : 'Collapse frame',
          ),
        );
      },
      onSelectAll: () => selectionStore.selectMultiple(frame.tileIds),
      // Context-menu delete shares the same confirm
      // gate as the Frame.svelte trash button so neither entry point
      // can rip out a frame without a stop-the-world confirmation.
      onDelete: () => confirmRemoveFrame({
        tileCount: frame.tileIds.length,
        openConfirm: uiStore.openConfirm,
        onConfirmed: () => boardStore.removeFrameWithHistory(frame.id),
      }),
    });
    uiStore.showContextMenu(e.clientX, e.clientY, items, frame.id);
  }

  // ── Click on canvas background clears selection / cancels connection drawing ──
  function handleCanvasClick(e: MouseEvent) {
    if (e.target === canvasContainer || (e.target as HTMLElement)?.classList?.contains('canvas-transform')) {
      // Move focus off any tile's TipTap editor so the global Delete shortcut
      // isn't swallowed by ProseMirror after a click-empty-canvas-then-Delete.
      const ae = document.activeElement as HTMLElement | null;
      if (ae?.isContentEditable) ae.blur();
      if (!e.shiftKey) {
        selectionStore.clear();
      }
      // Cancel connection drawing if clicking on empty canvas
      if (connectionsStore.drawing) {
        connectionsStore.cancelDrawing();
      }
    }
  }

  // ── Keyboard handler ──
  //
  // Keyboard-operable Mind Map.
  // Bindings (only fire when focus is NOT inside an editable text target):
  //
  //   • Escape         — cancel connection-drawing / exit connection mode
  //   • Arrow keys     — replace selection with the nearest neighbour in
  //                      the pressed direction (anchored on the most-recent
  //                      selected tile)
  //   • Ctrl+Shift+Arrow — extend selection in the pressed direction
  //   • Ctrl+Arrow     — move the selected tile(s) by 10 canvas px
  //   • N              — create a new tile near the focused selection (or
  //                      the viewport centre if nothing is selected)
  //   • Enter          — start renaming the focused tile (selects its
  //                      TileHeader title input; falls back to focus-only
  //                      when no header is mounted)
  //   • Del / Backspace — delete the selected tile(s) via the standard
  //                      cascade-aware confirm gate
  //   • C              — start a connection from the focused tile
  function handleKeydown(e: KeyboardEvent) {
    // Pane-scope gate. `<svelte:window onkeydown>` fires for
    // EVERY mounted Mind Map pane, so without this an inactive split pane would
    // also act on a bare key: one `n` creating a tile on two boards, arrows
    // moving the selection in both, Delete/Backspace double-dispatching. Mirror
    // Kanban / Task List, which gate their shared bare-key shortcuts on the
    // focused pane (the pointerdown that focuses a pane sets the active scope).
    if (!isActiveScope(scope)) return;
    // TipTap (and any input/textarea) needs Ctrl+Arrow for word-jump.
    if (isArrowConsumingTarget(document.activeElement)) return;

    if (e.key === 'Escape') {
      if (connectionsStore.drawing) {
        connectionsStore.cancelDrawing();
      } else if (connectionsStore.connectionMode) {
        connectionsStore.setConnectionMode(false);
      }
      return;
    }

    if (e.ctrlKey && e.shiftKey && isArrowKey(e.key)) {
      e.preventDefault();
      const ids = [...selectionStore.selectedIds];
      const tilesMap = boardStore.tiles;
      const tilesArr = Object.values(tilesMap);
      if (tilesArr.length === 0) return;

      if (ids.length === 0) {
        const first = tilesArr[0];
        if (first) selectionStore.select(first.id);
        return;
      }

      // Anchor on the most-recently-selected tile so consecutive presses
      // walk the selection through neighbors (matching IDE Shift+Arrow).
      const anchor = boardStore.getTile(ids[ids.length - 1] ?? '');
      if (!anchor) return;

      const best = findNeighborTile({
        key: e.key,
        anchor,
        candidates: tilesArr,
        excludeIds: new Set(ids),
      });

      if (best) selectionStore.select(best.id, true);
      return;
    }

    // Ctrl+Arrow without Shift — move the selected tile(s) 10 canvas px.
    if (e.ctrlKey && !e.shiftKey && isArrowKey(e.key)) {
      const ids = [...selectionStore.selectedIds];
      if (ids.length === 0) return;
      e.preventDefault();
      const dx = e.key === 'ArrowLeft' ? -10 : e.key === 'ArrowRight' ? 10 : 0;
      const dy = e.key === 'ArrowUp' ? -10 : e.key === 'ArrowDown' ? 10 : 0;
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- short-lived local map handed straight to MoveTilesCommand; never read reactively.
      const moves = new Map<string, { before: { x: number; y: number }; after: { x: number; y: number } }>();
      for (const id of ids) {
        const t = boardStore.getTile(id);
        if (!t || t.locked) continue;
        moves.set(id, {
          before: { x: t.position.x, y: t.position.y },
          after: { x: t.position.x + dx, y: t.position.y + dy },
        });
      }
      if (moves.size === 0) return;
      // Push a single MoveTilesCommand so the keypress move is undoable
      // exactly like a mouse-drag move. Multi-key holds create several
      // history entries (each press is one command), matching how
      // tileDrag commits a command per drag-end.
      historyStore.execute(new MoveTilesCommand(moves));
      return;
    }

    // Bare Arrow (no modifiers) — replace selection with the nearest
    // neighbour in that direction.
    if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && isArrowKey(e.key)) {
      const tilesMap = boardStore.tiles;
      const tilesArr = Object.values(tilesMap);
      if (tilesArr.length === 0) return;
      e.preventDefault();
      const ids = [...selectionStore.selectedIds];
      if (ids.length === 0) {
        const first = tilesArr[0];
        if (first) selectionStore.select(first.id);
        return;
      }
      const anchor = boardStore.getTile(ids[ids.length - 1] ?? '');
      if (!anchor) return;
      const best = findNeighborTile({
        key: e.key,
        anchor,
        candidates: tilesArr,
        excludeIds: new Set([anchor.id]),
      });
      if (best) selectionStore.select(best.id);
      return;
    }

    // Delete is owned by the GLOBAL gated `tile:delete` command (AppShell),
    // which also removes selected connections + offers the delete-backing-file
    // option; handling `Delete` here too would double-dispatch (two confirm
    // dialogs). `Backspace` stays as a board-local,
    // tiles-only alias (pane-gated above) so the mind map keeps its
    // Backspace-to-delete affordance without a second GLOBAL Backspace binding
    // (which would double-fire against Task List / Kanban rows that bind it).
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey) {
      const ids = [...selectionStore.selectedIds];
      if (ids.length === 0) return;
      e.preventDefault();
      uiStore.openConfirm({
        title: ids.length === 1 ? 'Delete tile?' : `Delete ${ids.length} tiles?`,
        body: ids.length === 1
          ? 'The placement is removed from this board. Backing vault files are preserved. You can undo this.'
          : `${ids.length} placements will be removed from this board. Backing vault files are preserved. You can undo this.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => {
          boardStore.removeTilesWithHistory(ids);
          selectionStore.clear();
        },
      });
      return;
    }

    if (e.key === 'n' || e.key === 'N') {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      // Anchor next to the most-recently-selected tile when available; fall
      // back to viewport centre via the existing helper.
      const ids = [...selectionStore.selectedIds];
      if (ids.length === 0) {
        createTileAtViewportCenter();
        return;
      }
      const anchor = boardStore.getTile(ids[ids.length - 1] ?? '');
      if (!anchor) {
        createTileAtViewportCenter();
        return;
      }
      const now = Date.now();
      const newId = createId();
      boardStore.addTileWithHistory({
        id: newId,
        type: 'text',
        title: boardStore.getNextTileName(),
        position: {
          x: anchor.position.x + anchor.size.width + 40,
          y: anchor.position.y,
        },
        size: { width: TILE_DEFAULTS.width, height: TILE_DEFAULTS.height },
        style: defaultTileStyleSnapshot(),
        locked: false,
        faded: false,
        tags: [],
        boardId: boardStore.current?.id ?? '',
          content: '',
        createdAt: now,
        updatedAt: now,
      });
      selectionStore.select(newId);
      return;
    }

    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
      const ids = [...selectionStore.selectedIds];
      if (ids.length !== 1) return;
      // Trigger the focused tile's rename flow via a `request-rename`
      // custom event. TileHeader listens on `window` and filters by
      // tileId, opening the same inline editor the title double-click
      // uses.
      e.preventDefault();
      window.dispatchEvent(
        new CustomEvent('request-rename', { detail: { tileId: ids[0] } }),
      );
      return;
    }

    if (e.key === 'c' || e.key === 'C') {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const ids = [...selectionStore.selectedIds];
      if (ids.length !== 1) return;
      const tile = boardStore.getTile(ids[0] ?? '');
      if (!tile) return;
      e.preventDefault();
      // Enter connection mode so the user's next click on another tile
      // completes the connection (handled by ConnectionLayer's pointer
      // wiring). Escape exits the mode without creating a connection.
      connectionsStore.setConnectionMode(true);
      return;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="mindmap-board"
  class:connection-mode={inConnectionMode}
  class:shift-hover={marquee.shiftPressed && !inConnectionMode}
  bind:this={canvasContainer}
  role="application"
  aria-label="Mind map canvas"
  aria-roledescription="Infinite canvas. Drag to pan, scroll to zoom, shift-drag to box-select."
  tabindex="0"
  use:viewportAction={canvasStore}
  use:dragDropAction={scope}
  use:edgePanAction
  onpointerdown={(e) => marquee.handlePointerDown(e)}
  onpointermove={(e) => marquee.handlePointerMove(e)}
  onpointerup={(e) => marquee.handlePointerUp(e)}
  oncontextmenu={handleContextMenu}
  onclick={handleCanvasClick}
>
  <!-- Background pattern (sits OUTSIDE the canvas transform so it scales
       via background-size rather than CSS transform — avoids the 40000px
       monster element and lets dots/grid stay visually consistent at any
       zoom). -->
  <BoardBackground
    pattern={viewModel.bgPattern}
    bgColor={viewModel.bgColor}
    panX={bgPanX}
    panY={bgPanY}
    scale={bgScale}
  />

  <!-- Canvas content layer with transform -->
  <div class="canvas-transform" style={transformStyle}>
    <!-- Frames (rendered behind tiles) -->
    {#each boardStore.frames as frame (frame.id)}
      <FrameComponent
        {frame}
        oncontextmenu={(e: MouseEvent, f: Frame) => showFrameContextMenu(e, f)}
      />
    {/each}

    <!-- Connection layer (SVG overlay) -->
    <ConnectionLayer
      spatialIndex={spatialStore.index}
      onstyleopen={(connection, x, y) => popups?.openConnectionStyle(connection, x, y)}
    />

    <!-- Tiles -->
    {#each viewModel.visibleTiles as tile (tile.id)}
      <TileContainer {tile}>
        {#if tile.type === 'text'}
          <TextTile {tile} />
        {:else if tile.type === 'image'}
          <ImageTile {tile} />
        {:else if tile.type === 'video'}
          <VideoTile {tile} />
        {:else if tile.type === 'file'}
          <FileTile {tile} />
        {:else if tile.type === 'audio'}
          <AudioTile {tile} />
        {:else if tile.type === 'link'}
          <LinkTile {tile} />
        {:else if tile.type === 'iframe'}
          <IframeTile {tile} />
        {:else if tile.type === 'timer'}
          <TimerTile {tile} />
        {/if}
      </TileContainer>
    {/each}

    <!-- Smart alignment guides -->
    <SmartGuides />

    <!-- Waypoint markers (visible when the Waypoints toggle is on; the
         Minimap toggle is independent and controls only the radar panel).
         Read straight off `boardStore.current` to mirror the minimap and
         keep both surfaces on the same reactivity root. -->
    {#if canvasStore.waypointsVisible}
      {@const wps = boardStore.current?.type === 'mindmap' ? (boardStore.current.waypoints ?? []) : []}
      {#each wps as wp (wp.id)}
        <WaypointMarker waypoint={wp} />
      {/each}
    {/if}
  </div>

  <!-- Selection box overlay -->
  {#if selectionStore.boxRect}
    {@const box = selectionStore.boxRect}
    <div
      class="selection-box"
      style="
        left: {box.left * canvasStore.scale + canvasStore.x}px;
        top: {box.top * canvasStore.scale + canvasStore.y}px;
        width: {box.width * canvasStore.scale}px;
        height: {box.height * canvasStore.scale}px;
        z-index: var(--z-selection-box);
      "
    ></div>
  {/if}

  <!-- Empty-state CTA. Sits above the background but below the side
       toolbar / minimap. Pointer events go through to the canvas around the
       card so the user can still pan / right-click. -->
  {#if viewModel.isBoardEmpty}
    <div class="empty-state" aria-live="polite">
      <div class="empty-state-card">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M12 8v8M8 12h8"/>
        </svg>
        <h2>This Mind Map is empty</h2>
        <p>Add a tile to start mapping. Right-click anywhere for more options, or drop files in from your vault.</p>
        <button
          type="button"
          class="empty-state-cta"
          onclick={createTileAtViewportCenter}
        >
          Create your first tile
        </button>
        <p class="empty-state-hint">
          Pan: drag · Zoom: scroll · Select box: shift-drag
        </p>
      </div>
    </div>
  {/if}

  <!-- Side toolbar -->
  {#if uiStore.boardToolbarVisible}
    <SideToolbar />
  {/if}

  <!-- Minimap -->
  {#if canvasStore.minimapVisible}
    <Minimap bgColor={viewModel.bgColor} />
  {/if}

  <!-- Zoom indicator (also surfaces the active LOD level so users understand
       why tiles look simpler/blocky at low zoom — they think it's a bug
       otherwise). -->
  <div class="zoom-indicator" title={canvasStore.lodLevel === 'full'
    ? 'Full detail rendering'
    : canvasStore.lodLevel === 'simplified'
      ? 'Simplified rendering — zoom in (Ctrl+=) for full detail'
      : 'Block view — zoom in (Ctrl+=) for full detail'}>
    {Math.round(canvasStore.scale * 100)}%
    {#if canvasStore.lodLevel !== 'full'}
      <span class="zoom-indicator-lod">
        · {canvasStore.lodLevel === 'simplified' ? 'simplified' : 'block view'}
      </span>
    {/if}
  </div>

  <!-- Connection mode indicator -->
  {#if inConnectionMode}
    <div class="connection-mode-indicator" role="status" aria-live="polite">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8.59 13.51l6.83-3.02"/>
      </svg>
      <span>Connection Mode</span>
      <span class="hint">Click bubbles to connect</span>
      <button
        type="button"
        class="connection-mode-exit"
        title="Exit connection mode (Esc)"
        aria-label="Exit connection mode"
        onclick={() => connectionsStore.setConnectionMode(false)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  {/if}
</div>

<MindMapPopups bind:this={popups} />

<style>
  .mindmap-board {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }

  .mindmap-board.connection-mode {
    cursor: crosshair;
  }

  /* Holding Shift over the canvas previews the box-select gesture without
     the user needing to start dragging — a passive discovery cue. */
  .mindmap-board.shift-hover {
    cursor: crosshair;
  }

  .canvas-transform {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    will-change: transform;
  }

  /* ── Selection box ── */
  .selection-box {
    position: absolute;
    background: var(--selection-bg);
    border: 1px solid var(--selection-border);
    pointer-events: none;
    border-radius: 2px;
  }

  /* ── Zoom indicator ── */
  .zoom-indicator {
    position: fixed;
    bottom: 56px;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 12px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    font-size: 11px;
    color: var(--text-secondary);
    /* The tooltip explains LOD modes — must be hover-targetable. */
    pointer-events: auto;
    opacity: 0.8;
    z-index: var(--z-canvas-hud);
  }

  .zoom-indicator-lod {
    margin-left: 4px;
    color: var(--accent-primary);
  }

  /* ── Connection mode indicator ── */
  .connection-mode-indicator {
    position: fixed;
    top: 56px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 16px;
    background: var(--accent-primary);
    color: var(--text-inverse);
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    box-shadow: var(--ui-shadow-lg);
    z-index: var(--z-canvas-hud);
    animation: slideDownCentered 0.2s ease;
    /* Restore pointer events so the exit button is reachable; non-button
       text spans don't intercept clicks because they have no handlers. */
    pointer-events: auto;
  }

  .connection-mode-exit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .connection-mode-exit:hover,
  .connection-mode-exit:focus-visible {
    background: rgba(255, 255, 255, 0.18);
  }

  .connection-mode-indicator .hint {
    font-weight: 400;
    opacity: 0.8;
    font-size: 11px;
  }

  @keyframes slideDownCentered {
    from {
      transform: translateX(-50%) translateY(-10px);
      opacity: 0;
    }
    to {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
  }

  /* drag-over visual feedback */
  :global(.drag-over) {
    outline: 2px dashed var(--accent-primary);
    outline-offset: -2px;
  }

  /* ── Empty-state overlay ── */
  .empty-state {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    z-index: 100;
  }

  .empty-state-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 28px 36px;
    max-width: 380px;
    text-align: center;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    box-shadow: var(--ui-shadow-elevated);
    pointer-events: auto;
    color: var(--text-primary);
  }

  .empty-state-card h2 {
    margin: 4px 0 0;
    font-size: 16px;
    font-weight: 600;
  }

  .empty-state-card p {
    margin: 0;
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .empty-state-cta {
    margin-top: 8px;
    padding: 8px 18px;
    border: 0;
    border-radius: 6px;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.15s ease;
  }

  .empty-state-cta:hover {
    filter: brightness(1.08);
  }

  .empty-state-hint {
    margin-top: 4px;
    font-size: 11px;
    opacity: 0.7;
  }
</style>
