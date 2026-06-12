<script lang="ts">
  /**
   * PaneView — a single workspace pane. Each pane owns its own
   * `BoardScope` (board + canvas + selection + spatial state) so two
   * panes can render different boards independently. The active pane is
   * the one whose scope backs the global facades (`boardStore` etc.) —
   * workspace-level services (hotkeys, GlobalToolbar, command registry)
   * resolve via that facade.
   *
   * Activation is tracked at the workspace level (`workspaceStore.activePaneId`).
   * A capture-phase pointerdown listener activates the pane on first input
   * so the global facade pivots BEFORE downstream pointer handlers (drag,
   * zoom, select) read board/canvas/selection state. Activation also
   * retargets the focused tab.
   */
  import { onMount, onDestroy, setContext } from 'svelte';
  import BoardRouter from '../boards/BoardRouter.svelte';
  import { workspaceStore } from '../../stores/workspace.svelte';
  import { tabStore } from '../../stores/tabs.svelte';
  import { historyStore } from '../../stores/history.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import {
    BOARD_SCOPE_KEY,
    setActiveScope,
    isActiveScope,
    resetActiveScope,
    type BoardScope,
  } from '../../lib/boards/boardScope.svelte';
  import { createBoardScope } from '../../lib/boards/boardScopeFactory';

  interface Props {
    paneId: string;
    tabId: string;
  }

  let { paneId, tabId }: Props = $props();

  // Each pane mounts a fresh scope. Components inside the pane read it
  // via `getContext(BOARD_SCOPE_KEY)`. The scope lives for the pane's
  // lifetime — closing the pane drops the reference (GC reclaims it).
  const scope: BoardScope = createBoardScope();
  setContext(BOARD_SCOPE_KEY, scope);

  let isActive = $derived(workspaceStore.activePaneId === paneId);
  // The blue active-pane outline only carries information when there is
  // more than one pane open. In a single-pane session (the common case)
  // it just reads as a stray "selected" border on the board canvas.
  let showActiveOutline = $derived(isActive && workspaceStore.leafCount > 1);
  let tab = $derived(tabStore.tabs.find((t) => t.id === tabId));

  // Mirror activation into the global facade: whenever this pane is the
  // active pane, the four global stores (`boardStore` etc.) resolve to
  // this scope. Workspace services (hotkeys, GlobalToolbar) read via
  // those globals and therefore target this pane.
  //
  // History is keyed per-board (not per-pane), and `historyStore` tracks a
  // single global `activeBoardId`. Re-target it on every activation so
  // undo/redo from the GlobalToolbar / hotkeys operate against the active
  // pane's board — the per-board stack stays valid because two panes
  // showing the same board share the same stack.
  $effect(() => {
    if (isActive) {
      setActiveScope(scope);
      const id = scope.board.current?.id ?? null;
      historyStore.setActiveBoard(id);
    }
  });

  // On first mount, if no pane is active yet (boot path), claim activation
  // so the global facades have a target. Subsequent activation flows go
  // through the workspaceStore.
  onMount(() => {
    if (workspaceStore.activePaneId === null) {
      workspaceStore.setActivePane(paneId);
    }
  });

  // Audit 3.2 — closing a pane drops the scope reference, but a fly-to RAF
  // started in this pane keeps ticking (and would persist a stale viewport)
  // because nothing routes a closing pane through canvas.setBoard(null).
  // Tear the canvas scope down explicitly so the animation frame is cancelled
  // and any pending viewport persist is flushed.
  //
  // Audit-16 6.6 — if THIS pane's scope still backs the global facades when
  // it unmounts (the last pane closing — vault swap already resets via the
  // pre-swap hook, and a pane close with survivors re-targets via the
  // surviving pane's activation $effect), drop it. Otherwise `boardStore` /
  // `canvasStore` etc. keep delegating to the destroyed pane's scope, and a
  // workspace-level consumer (hotkey, toolbar) could mutate the closed
  // board's cache through it. The guard makes this a no-op whenever any
  // other pane has (or will have) claimed activation.
  onDestroy(() => {
    scope.canvas.destroy();
    if (isActiveScope(scope)) {
      resetActiveScope();
    }
  });

  function activate() {
    if (!isActive) {
      workspaceStore.setActivePane(paneId);
      if (tab && tabStore.activeTabId !== tab.id) {
        tabStore.setActive(tab.id);
      }
    }
  }

  // Capture-phase pointerdown fires before any inner pointer handler, so
  // the global facade has pivoted to this pane's scope by the time
  // canvas/tile/drag handlers read `boardStore` / `canvasStore` / etc.
  function onPointerDownCapture() {
    activate();
  }

  function closePane(e: MouseEvent) {
    e.stopPropagation();
    workspaceStore.closeLeaf(paneId);
  }

  let canClose = $derived(workspaceStore.leafCount > 1);
</script>

<div
  class="pane-view"
  class:active={showActiveOutline}
  onpointerdowncapture={onPointerDownCapture}
  role={tab ? 'tabpanel' : 'group'}
  id={tab ? `tabpanel-${tab.id}` : undefined}
  aria-labelledby={tab ? `tab-${tab.id}` : undefined}
  aria-label={tab ? undefined : 'Pane'}
>
  {#if tab}
    <BoardRouter {tabId} />
  {:else}
    <div class="pane-empty">
      <div class="pane-empty-card">
        <p class="pane-empty-title">No board open in this pane</p>
        <p class="pane-empty-hint">Drag a tab here, or open one from the Board Browser.</p>
        <button
          type="button"
          class="pane-empty-btn"
          onclick={() => uiStore.openModal('board-browser')}
        >
          Open Board Browser
        </button>
      </div>
    </div>
  {/if}

  {#if canClose}
    <button
      class="pane-close"
      onclick={closePane}
      title="Close pane"
      aria-label="Close pane"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  {/if}
</div>

<style>
  .pane-view {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--canvas-bg);
    outline: 0 solid transparent;
    transition: outline-color 0.15s ease;
  }

  .pane-view.active {
    outline: 2px solid var(--accent-primary);
    outline-offset: -2px;
  }

  .pane-empty {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    font-family: var(--font-system);
    font-size: var(--font-size-base);
    padding: 24px;
  }

  .pane-empty-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    max-width: 320px;
    text-align: center;
    padding: 24px;
    border: 1px dashed var(--ui-border);
    border-radius: 10px;
    background: var(--ui-surface);
  }

  .pane-empty-title {
    margin: 0;
    color: var(--text-secondary);
    font-weight: 600;
  }

  .pane-empty-hint {
    margin: 0;
    color: var(--text-tertiary);
    font-size: 12px;
    line-height: 1.5;
  }

  .pane-empty-btn {
    margin-top: 8px;
    padding: 6px 14px;
    border: 1px solid var(--accent-primary);
    border-radius: 6px;
    background: var(--accent-primary);
    color: var(--text-inverse, white);
    font-family: inherit;
    font-size: var(--font-size-base);
    cursor: pointer;
    transition: opacity 0.15s ease;
  }

  .pane-empty-btn:hover {
    opacity: 0.9;
  }

  .pane-close {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-secondary);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease, background-color 0.12s ease;
  }

  .pane-view:hover .pane-close,
  .pane-view:focus-within .pane-close {
    opacity: 0.8;
  }

  .pane-close:hover,
  .pane-close:focus-visible {
    opacity: 1;
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }
</style>
