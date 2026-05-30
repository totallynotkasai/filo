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
  import {
    BOARD_SCOPE_KEY,
    type BoardScope,
  } from '../../lib/boards/boardScope.svelte';
  import { reportError } from '../../lib/utils/errorBus';
  import type { Board } from '../../schema/index';

  interface Props {
    tabId: string;
  }

  let { tabId }: Props = $props();

  const scope = getContext<BoardScope>(BOARD_SCOPE_KEY);

  let tab = $derived(tabStore.tabs.find((t) => t.id === tabId));
  let boardType = $derived(tab?.boardType ?? null);
  let ActiveBoardComponent = $derived.by(() => {
    if (!boardType) return null;
    return boardRegistry[boardType]?.component ?? null;
  });

  // ── Load board data when tab changes ──
  // IMPORTANT: Only track `tab` — untrack all project data reads to prevent
  // re-running (and resetting the camera) on every tile/connection update.
  $effect(() => {
    const t = tab;
    if (!t) {
      scope.board.clearBoard();
      scope.selection.clear();
      // Flush any pending viewport persist for the OUTGOING board and
      // clear currentBoardId so subsequent transform mutations can't
      // bleed into a stale board.
      scope.canvas.setBoard(null);
      return;
    }

    // Document tabs read from documentStore, not boardStore — skip board loading
    if (t.boardType === 'document') {
      scope.selection.clear();
      scope.canvas.setBoard(null);
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

      // Phase R7 — per-pane `tiles` / `connections` / `frames` views are
      // `$derived` from the shared `boardCacheStore.cache[board.id]`.
      // `setBoard(board)` only needs to pin the scope to a board id; the
      // legacy tiles/connections/frames args are reserved for the unit-test
      // bootstrap path.
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
  });
</script>

{#if tab}
  {#key tab.id}
    <div class="board-transition">
      {#if ActiveBoardComponent}
        <ActiveBoardComponent />
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

  .placeholder-label {
    font-size: 18px;
    font-weight: 500;
    color: var(--text-secondary);
    margin: 0;
  }
</style>
