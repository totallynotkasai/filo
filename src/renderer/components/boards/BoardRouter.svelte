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
  import { themeStore } from '../../stores/theme.svelte';
  import type { Board } from '../../schema/index';
  import UnloadedBoardTab from './UnloadedBoardTab.svelte';

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

  /**
   * Whether the tab's board is in the cache (or the project). A tab can
   * outlive its board for a moment (the board deleted while its tab shows in
   * another pane, before the delete closes the tab): the pane then shows that
   * the board is gone. It never makes a default board under the id, which a
   * save would write as a second board file with the deleted board's id.
   * A boolean, so the effect below re-runs only when the board comes or goes.
   */
  let boardPresent = $derived(
    !!tab && (
      tab.boardType === 'document'
      || tab.unloadedPath !== undefined
      || !!boardCacheStore.cache[tab.boardId]
      || !!vaultStore.project?.boards?.some((b) => b.id === tab.boardId)
    ),
  );

  // ── Load board data when tab changes ──
  // IMPORTANT: Only track `tab` and `boardPresent` — untrack all project data
  // reads to prevent re-running (and resetting the camera) on every
  // tile/connection update.
  $effect(() => {
    const t = tab;
    const present = boardPresent;
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

    // A tab whose board file couldn't be loaded: the scope is emptied, and
    // no default board is made for it (it would be saved over the file).
    if (t.unloadedPath !== undefined) {
      untrack(() => {
        scope.board.clearBoard();
        scope.selection.clear();
        scope.canvas.setBoard(null);
      });
      pinnedTabId = t.id;
      return;
    }

    // Document tabs read the note store, not boardStore — skip board loading
    if (t.boardType === 'document') {
      scope.selection.clear();
      scope.canvas.setBoard(null);
      pinnedTabId = t.id;
      return;
    }

    // The board isn't there (any more): nothing to show, and nothing made.
    if (!present) {
      untrack(() => {
        scope.board.clearBoard();
        scope.selection.clear();
        scope.canvas.setBoard(null);
      });
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
      // source of truth.
      const board: Board | undefined =
        (boardCacheStore.cache[t.boardId]?.board as Board | undefined) ??
        project.boards?.find((b: Board) => b.id === t.boardId);
      if (!board) return;

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
      {#if tab.unloadedPath !== undefined}
        <UnloadedBoardTab {tab} />
      {:else if !boardPresent}
        <div class="board-placeholder-type" role="status">
          <p class="placeholder-label">"{tab.name}" isn't open any more</p>
          <p class="placeholder-hint">It may have been deleted. Nothing was saved in its place.</p>
          <button class="placeholder-close" onclick={() => { void tabStore.close(tab.id); }}>Close tab</button>
        </div>
      {:else if boardModule && pinnedTabId !== tab.id}
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

  .placeholder-hint {
    margin: 0;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .placeholder-close {
    padding: 6px 16px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
  }
</style>
