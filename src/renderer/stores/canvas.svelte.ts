import { CANVAS_DEFAULTS } from '../constants/defaults';
import { boardCacheStore } from './boardCache.svelte';
import { getActiveScope, makeFacade } from '../lib/boards/boardScope.svelte';
import { workspaceStore } from './workspace.svelte';

/**
 * Canvas transform state for a board view. Each `BoardScope` owns its own
 * `CanvasScope` so two panes can pan/zoom independently. The exported
 * `canvasStore` is a global facade Proxy that delegates to the active scope.
 */

export interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
}

export interface ViewportRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface CanvasScope {
  readonly transform: CanvasTransform;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly minimapVisible: boolean;
  readonly semanticZoomEnabled: boolean;
  readonly snapEnabled: boolean;
  readonly waypointsVisible: boolean;
  readonly isSemanticZoomActive: boolean;
  readonly lodLevel: 'full' | 'simplified' | 'block';
  readonly viewportRect: ViewportRect;
  /** The canvas element's left edge in window pixels (0 before one is mounted). */
  readonly viewportScreenLeft: number;
  setBoard(boardId: string | null): void;
  setTransform(t: CanvasTransform): void;
  panBy(dx: number, dy: number): void;
  zoomTo(newScale: number, centerX: number, centerY: number): void;
  zoomBy(factor: number, centerX: number, centerY: number): void;
  centerOn(canvasX: number, canvasY: number): void;
  setViewportSize(width: number, height: number): void;
  /** The element the canvas is drawn in, read for `viewportScreenLeft`. */
  setViewportElement(el: HTMLElement | null): void;
  flyTo(target: CanvasTransform, durationMs?: number): void;
  toggleMinimap(): void;
  setSemanticZoomEnabled(v: boolean): void;
  setSnapEnabled(v: boolean): void;
  toggleWaypointsVisible(): void;
  setWaypointsVisible(v: boolean): void;
  /** Writes a camera move still inside its idle window to the board now (save, leave). */
  flushViewport(): void;
  /** Pane-teardown hook: cancels the in-flight fly and flushes the viewport. */
  destroy(): void;
}

/**
 * Factory: creates a fresh per-pane canvas scope. Each scope holds its own
 * pan/zoom transform, viewport dimensions, semantic-zoom flag, minimap
 * visibility, debounced viewport-persist timer, and active fly-to RAF.
 */
export function createCanvasScope(): CanvasScope {
  let transform = $state<CanvasTransform>({ x: 0, y: 0, scale: 1 });
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  // Read when asked, not tracked: a pane can move (a split divider, the
  // sidebar pushing it aside) without its size changing.
  let viewportElement: HTMLElement | null = null;
  let semanticZoomEnabled = $state(true);
  let snapEnabled = $state(false);
  // The board the minimap and waypoints toggles belong to: they are
  // remembered per board, in the workspace store (`.filo/workspace.json`).
  let panelsBoardId = $state<string | null>(null);

  // Active camera-fly animation (null when idle).
  let flyToRaf: number | null = null;

  function cancelFlyTo() {
    if (flyToRaf != null) {
      cancelAnimationFrame(flyToRaf);
      flyToRaf = null;
    }
  }

  // ── Per-board viewport persistence ──
  //
  // Tracks the active mind-map board so `panBy` / `zoomTo` / `flyTo` / etc.
  // can route the resulting transform back to `boardCacheStore.updateViewport`
  // after an idle window. The 1500ms debounce keeps the chatty pan/zoom
  // stream from spamming markDirty during exploration — the user is "done
  // moving" when their cursor stops. Tab/board blur paths (`setBoard(null)`,
  // `clearBoard`) flush synchronously via `flushPendingViewport`, so the
  // longer window only affects the steady-state pan/zoom stream, not
  // navigation.
  //
  // Non-mindmap boards (Kanban, TaskList, Document) don't have a canvas, so
  // `currentBoardId` stays null and the persistence path no-ops.
  let currentBoardId: string | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const VIEWPORT_PERSIST_DEBOUNCE_MS = 1500;

  function schedulePersistViewport(): void {
    if (!currentBoardId) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!currentBoardId) return;
      boardCacheStore.updateViewport(currentBoardId, {
        x: transform.x,
        y: transform.y,
        scale: transform.scale,
      });
    }, VIEWPORT_PERSIST_DEBOUNCE_MS);
  }

  function flushPendingViewport(): void {
    if (!persistTimer) return;
    clearTimeout(persistTimer);
    persistTimer = null;
    if (!currentBoardId) return;
    boardCacheStore.updateViewport(currentBoardId, {
      x: transform.x,
      y: transform.y,
      scale: transform.scale,
    });
  }

  const store: CanvasScope = {
    get transform() { return transform; },
    get x() { return transform.x; },
    get y() { return transform.y; },
    get scale() { return transform.scale; },
    get viewportWidth() { return viewportWidth; },
    get viewportHeight() { return viewportHeight; },
    get minimapVisible() { return panelsBoardId ? workspaceStore.mindMapPanelsOf(panelsBoardId).minimap : true; },
    get semanticZoomEnabled() { return semanticZoomEnabled; },
    get snapEnabled() { return snapEnabled; },
    get waypointsVisible() { return panelsBoardId ? workspaceStore.mindMapPanelsOf(panelsBoardId).waypoints : true; },

    get isSemanticZoomActive(): boolean {
      return semanticZoomEnabled && transform.scale < CANVAS_DEFAULTS.semanticZoomThreshold;
    },

    get lodLevel(): 'full' | 'simplified' | 'block' {
      if (!semanticZoomEnabled) return 'full';
      if (transform.scale < CANVAS_DEFAULTS.semanticZoomBlockThreshold) return 'block';
      if (transform.scale < CANVAS_DEFAULTS.semanticZoomThreshold) return 'simplified';
      return 'full';
    },

    get viewportRect(): ViewportRect {
      const left = -transform.x / transform.scale;
      const top = -transform.y / transform.scale;
      const width = viewportWidth / transform.scale;
      const height = viewportHeight / transform.scale;
      return { left, top, right: left + width, bottom: top + height, width, height };
    },

    get viewportScreenLeft(): number {
      return viewportElement?.getBoundingClientRect().left ?? 0;
    },

    setBoard(boardId: string | null) {
      // Kill any in-flight camera fly before re-pointing the scope, else the
      // RAF completes and persists the OLD board's fly target as the NEW
      // board's viewport. Covers board switch, board clear, and vault swap.
      cancelFlyTo();
      flushPendingViewport();
      currentBoardId = boardId;
      panelsBoardId = boardId;
      if (!boardId) {
        transform = { x: 0, y: 0, scale: 1 };
        return;
      }
      const saved = boardCacheStore.getViewport(boardId);
      transform = saved
        ? { x: saved.x, y: saved.y, scale: saved.scale }
        : { x: 0, y: 0, scale: 1 };
    },

    setTransform(t: CanvasTransform) {
      const scale = Number.isFinite(t.scale) && t.scale > 0
        ? Math.max(CANVAS_DEFAULTS.minZoom, Math.min(CANVAS_DEFAULTS.maxZoom, t.scale))
        : 1;
      transform = { x: t.x, y: t.y, scale };
      schedulePersistViewport();
    },

    panBy(dx: number, dy: number) {
      // Refuse NaN / Infinity inputs. A buggy gesture
      // handler or a hand-edited filo:// link would otherwise propagate
      // a non-finite delta into `transform.x/y`, freezing the canvas
      // (NaN poisons every subsequent matrix-multiplication).
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      cancelFlyTo();
      transform = { ...transform, x: transform.x + dx, y: transform.y + dy };
      schedulePersistViewport();
    },

    zoomTo(newScale: number, centerX: number, centerY: number) {
      // Any non-finite input is a no-op. NaN scale would
      // cascade to NaN transform.x/y on the next `centerX - (centerX -
      // transform.x) * scaleRatio` computation and lock the camera.
      if (
        !Number.isFinite(newScale) ||
        !Number.isFinite(centerX) ||
        !Number.isFinite(centerY)
      ) {
        return;
      }
      const clamped = Math.max(
        CANVAS_DEFAULTS.minZoom,
        Math.min(CANVAS_DEFAULTS.maxZoom, newScale),
      );

      const scaleRatio = clamped / transform.scale;
      const newX = centerX - (centerX - transform.x) * scaleRatio;
      const newY = centerY - (centerY - transform.y) * scaleRatio;

      transform = { x: newX, y: newY, scale: clamped };
      schedulePersistViewport();
    },

    zoomBy(factor: number, centerX: number, centerY: number) {
      // Guard here too because we multiply by transform.scale
      // before delegating; an Infinity * finite = Infinity, and we want
      // `zoomTo` to receive a pre-validated value.
      if (
        !Number.isFinite(factor) ||
        !Number.isFinite(centerX) ||
        !Number.isFinite(centerY)
      ) {
        return;
      }
      store.zoomTo(transform.scale * factor, centerX, centerY);
    },

    centerOn(canvasX: number, canvasY: number) {
      // Same NaN poison-pill rationale as the other
      // mutators. A filo:// link with `position/x/Infinity/Infinity`
      // would otherwise pan the canvas off-screen.
      if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) return;
      transform = {
        ...transform,
        x: viewportWidth / 2 - canvasX * transform.scale,
        y: viewportHeight / 2 - canvasY * transform.scale,
      };
      schedulePersistViewport();
    },

    setViewportSize(width: number, height: number) {
      viewportWidth = width;
      viewportHeight = height;
    },

    setViewportElement(el: HTMLElement | null) {
      viewportElement = el;
    },

    flyTo(target: CanvasTransform, durationMs = 300) {
      // Refuse non-finite targets so the RAF loop can't
      // animate towards NaN.
      if (
        !Number.isFinite(target.x) ||
        !Number.isFinite(target.y) ||
        !Number.isFinite(target.scale)
      ) {
        return;
      }
      cancelFlyTo();
      const reduce = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reduce || durationMs <= 0) {
        transform = { ...target };
        schedulePersistViewport();
        return;
      }

      const start = { ...transform };
      const startTime = performance.now();

      function step(now: number) {
        const t = Math.min(1, (now - startTime) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        transform = {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          scale: start.scale + (target.scale - start.scale) * eased,
        };
        if (t < 1) {
          flyToRaf = requestAnimationFrame(step);
        } else {
          flyToRaf = null;
          schedulePersistViewport();
        }
      }

      flyToRaf = requestAnimationFrame(step);
    },

    toggleMinimap() {
      if (panelsBoardId) workspaceStore.setMindMapPanel(panelsBoardId, 'minimap', !store.minimapVisible);
    },

    setSemanticZoomEnabled(v: boolean) {
      semanticZoomEnabled = v;
    },

    setSnapEnabled(v: boolean) {
      snapEnabled = v;
    },

    toggleWaypointsVisible() {
      if (panelsBoardId) workspaceStore.setMindMapPanel(panelsBoardId, 'waypoints', !store.waypointsVisible);
    },

    setWaypointsVisible(v: boolean) {
      if (panelsBoardId) workspaceStore.setMindMapPanel(panelsBoardId, 'waypoints', v);
    },

    flushViewport() {
      flushPendingViewport();
    },

    destroy() {
      // Pane-teardown hook (PaneView onDestroy). Cancel the
      // in-flight fly so a closed pane's RAF stops ticking, and flush any
      // pending viewport persist so the board's last camera move isn't lost.
      // flushPendingViewport no-ops when nothing is pending and when the
      // board is no longer in the cache (e.g. mid vault-swap teardown).
      cancelFlyTo();
      flushPendingViewport();
    },
  };

  return store;
}

/**
 * Global facade — every property access delegates to the active pane's
 * canvas scope. Workspace-level call sites (GlobalToolbar, hotkeys, command
 * registry) keep importing `canvasStore` and get the active scope's
 * transform/viewport transparently.
 */
export const canvasStore: CanvasScope = makeFacade(() => getActiveScope().canvas);
