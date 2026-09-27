<script lang="ts">
  /**
   * BoardRouter — renders the correct board component for a pane's tab.
   * Reads the per-pane `BoardScope` from Svelte context and hydrates THIS
   * pane's board into its scope (not the global facade) so two panes
   * showing different tabs each materialise the correct board.
   */
  import { untrack, getContext } from 'svelte';
  import { tabStore } from '../../stores/tabs.svelte';
  import { boardCacheStore } from '../../stores/boardCache.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { boardRegistry } from '../../core/boardRegistry';
  import { loadBoardModule } from '../../core/boardModules';
  import {
    BOARD_SCOPE_KEY,
    type BoardScope,
  } from '../../lib/boards/boardScope.svelte';
  import { reportError } from '../../lib/utils/errorBus';
  import { themeStore } from '../../stores/theme.svelte';
  import type { Board } from '../../schema/index';

  interface Props {
    tabId: string;
  }

  let { tabId }: Props = $props();

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);

  let tab = $derived(tabStore.tabs.find((t) => t.id === tabId));
  let boardType = $derived(tab?.boardType ?? null);
  // The board's module once loaded (rendered at once), or a promise for it
  // on first open. Derived from the type alone, so unrelated reactive
  // updates don't re-trigger the {#await}.
  let boardModule = $derived(
    boardType && boardRegistry[boardType] ? loadBoardModule(boardType) : null,
  );

  // The tab this pane's scope has been pointed at by the effect below. The
  // board component renders only once it matches the shown tab: on a tab
  // switch the `{#key}` block rebuilds before this effect re-runs, and a board
  // mounted then would start against the previous board's scope (its view
  // state effects hydrate for, and then write into, the other board's file).
  let pinnedTabId = $state<string | null>(null);

  // ── Load board data when tab changes ──
  // IMPORTANT: Only track `tab` — untrack all project data reads to prevent
  // re-running (and resetting the camera) on every tile/connection update.
  $effect(() => {
    const t = tab;
    if (!t) {
      pinnedTabId = null;
      scope.board.clearBoard();
      scope.selection.clear();
      // Flush any pending viewport persist for the OUTGOING board and
      // clear currentBoardId so subsequent transform mutations can't
      // bleed into a stale board.
      scope.canvas.setBoard(null);
      return;
    }

    // Document tabs read the note store, not boardStore — skip board loading
    if (t.boardType === 'document') {
      scope.selection.clear();
      scope.canvas.setBoard(null);
      pinnedTabId = t.id;
      return;
    }

    // Untrack project data reads so tile/connection/frame updates don't
    // re-trigger this effect.
    untrack(() => {
      const project = vaultStore.getData();
      if (!project) return;

      // Prefer the board cache: Kanban/Task-List boards live in
      // `.board.json` files and are only registered in `project.boards`
      // after first save, so on tab remount the cache is often the only
      // source of truth. Falling through to `createDefault` here would
      // clobber the cached board with an empty shell.
      let board: Board | undefined =
        (boardCacheStore.cache[t.boardId]?.board as Board | undefined) ??
        project.boards?.find((b: Board) => b.id === t.boardId);

      if (!board) {
        const registryEntry = boardRegistry[t.boardType];
        if (!registryEntry) return;

        board = registryEntry.createDefault(t.boardId, t.name, project.settings);

        if (!project.boards) project.boards = [];
        void scope.board.persistNewBoard(board).catch((err) =>
          reportError(
            'BoardRouter.auto-create',
            err,
            `Failed to persist newly-created board "${board?.name ?? t.boardId}"`,
          ),
        );
      }

      // Per-pane `tiles` / `connections` / `frames` views are `$derived`
      // from the shared `boardCacheStore.cache[board.id]`. `setBoard(board)`
      // only needs to pin the scope to a board id; the tiles/connections/frames
      // args are reserved for the unit-test bootstrap path.
      scope.board.setBoard(board);
      scope.selection.clear();

      // Hand the pane's canvas scope the new active board id. setBoard
      // flushes any pending viewport persist for the OUTGOING board and
      // hydrates the transform from the unified `.filo/viewports.json`
      // map (or resets to origin when no entry exists or the board isn't
      // canvas-based).
      const entry = boardRegistry[t.boardType];
      scope.canvas.setBoard(entry?.usesCanvas ? board.id : null);
    });
    pinnedTabId = t.id;
  });
</script>

{#snippet loading()}
  <div class="board-loading">
    <p class="board-loading-label" role="status">Loading board…</p>
  </div>
{/snippet}

<!-- "System colours only" re-skins the app's chrome but not boards. Kanban,
     Task List and Document surfaces are drawn with the same UI tokens as the
     chrome, so the board keeps the theme it had by carrying its
     `data-theme` (`themeStore.boardTheme`). -->
{#if tab}
  {#key tab.id}
    <div class="board-transition" data-theme={themeStore.boardTheme ?? undefined}>
      {#if boardModule && pinnedTabId !== tab.id}
        <!-- Only until the effect above has pinned the scope; that runs in
             the same flush, before the browser paints. -->
        {@render loading()}
      {:else if boardModule}
        {#await boardModule}
          {@render loading()}
        {:then mod}
          {@const ActiveBoardComponent = mod.default}
          <ActiveBoardComponent {tabId} />
        {:catch}
          <div class="board-placeholder-type">
            <p class="placeholder-label">Failed to load board</p>
          </div>
        {/await}
      {:else}
        <div class="board-placeholder-type">
          <p class="placeholder-label">Unknown Board Type</p>
        </div>
      {/if}
    </div>
  {/key}
{/if}

<style>
  .board-transition {
    width: 100%;
    height: 100%;
    animation: boardFadeIn 0.15s ease;
  }

  @keyframes boardFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .board-transition {
      animation: none;
    }
  }

  .board-placeholder-type {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    gap: 12px;
    background: var(--canvas-bg);
  }

  /* Placeholder while the lazily-imported board chunk loads on first open
     (instant once the idle preload or an earlier open has cached the module). */
  .board-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: var(--canvas-bg);
  }

  /* Shown only if the load takes over 150ms, so a fast load never flashes
     the text. The delay needs no timer: the label appears when the delay ends,
     and it is gone as soon as the module resolves. The reduced-motion rule in
     style.css shortens the fade but keeps the delay. */
  .board-loading-label {
    margin: 0;
    font-size: 14px;
    color: var(--text-secondary);
    opacity: 0;
    animation: boardLoadingLabelIn 0.15s ease 150ms forwards;
  }

  @keyframes boardLoadingLabelIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .placeholder-label {
    font-size: 18px;
    font-weight: 500;
    color: var(--text-secondary);
    margin: 0;
  }
</style>
