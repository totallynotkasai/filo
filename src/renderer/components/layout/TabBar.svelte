<script lang="ts">
  import { tabStore } from '../../stores/tabs.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import { boardStore } from '../../stores/board.svelte';
  import { createId } from '../../lib/utils/ids';
  import { isVaultFileKnown, newBoardPlace } from '../../lib/boards/newBoardPlace';
  import type { BoardType } from '../../../shared/types';
  import Tab from './Tab.svelte';
  import { boardRegistry } from '../../core/boardRegistry';
  import { handleListKeyNav } from '../../lib/utils/listKeyNav';
  import { BOARD_TYPE_ICON_PATH } from '../../constants/boardIcons';

  // Tab bar color flows through `--tabbar-bg` (written to :root by App.svelte
  // from `general.tabBarColor`). Height derives from `--ui-tabbar-scale`,
  // also written by App.svelte.

  let showNewTabMenu = $state(false);

  // Refs to the menu triggers so Escape-to-close can return
  // focus to the button that opened the popup (WAI-ARIA menu pattern).
  let newTabBtnEl = $state<HTMLButtonElement | null>(null);
  let overflowBtnEl = $state<HTMLButtonElement | null>(null);

  function closeNewTabMenu() {
    showNewTabMenu = false;
    newTabBtnEl?.focus();
  }

  function closeOverflowMenu() {
    showOverflowMenu = false;
    overflowBtnEl?.focus();
  }

  const allBoardTypes: { type: BoardType; label: string; icon: string }[] = [
    { type: 'mindmap', label: 'Mind Map', icon: BOARD_TYPE_ICON_PATH.mindmap },
    { type: 'kanban', label: 'Kanban', icon: BOARD_TYPE_ICON_PATH.kanban },
    { type: 'tasklist', label: 'Task List', icon: BOARD_TYPE_ICON_PATH.tasklist },
    { type: 'document', label: 'Document', icon: BOARD_TYPE_ICON_PATH.document },
  ];

  // Document board type isn't directly creatable — documents are opened via
  // "Expand to Document" on text tiles.
  const boardTypes = allBoardTypes.filter(b => b.type !== 'document');

  function openBoardBrowser() {
    showNewTabMenu = false;
    if (uiStore.isModalOpen('board-browser')) {
      uiStore.closeModal();
    } else {
      uiStore.openModal('board-browser');
    }
  }

  function getNextBoardName(type: BoardType): string {
    const labels: Record<BoardType, string> = {
      mindmap: 'Mind Map',
      kanban: 'Kanban',
      tasklist: 'Task List',
      document: 'Document',
    };
    // The lowest number whose file is free where the board would go: a taken
    // name is refused at create, never bumped to ` (2)`.
    const base = labels[type];
    let n = 1;
    while (isVaultFileKnown(newBoardPlace(`${base} ${n}`).path)) n++;
    return `${base} ${n}`;
  }

  async function createQuickBoard(type: BoardType) {
    showNewTabMenu = false;
    if (!vaultStore.project) return;

    // Single source of truth for default board shape per type.
    const board = boardRegistry[type].createDefault(
      createId(),
      getNextBoardName(type),
      vaultStore.project.settings,
    );

    // A failure has already said why.
    const ok = await boardStore.persistNewBoard(board);
    if (!ok) return;
    tabStore.open(board.id, board.name, board.type);
  }

  // Close menu on outside click
  function handleDocClick(e: MouseEvent) {
    if (showNewTabMenu) {
      const target = e.target as HTMLElement;
      if (!target.closest('.new-tab-wrapper')) {
        showNewTabMenu = false;
      }
    }
  }

  $effect(() => {
    document.addEventListener('click', handleDocClick, true);
    return () => document.removeEventListener('click', handleDocClick, true);
  });

  let tabListEl = $state<HTMLDivElement | null>(null);

  // E.9 — overflow affordance. A ResizeObserver mirrors the container's
  // scrollWidth vs clientWidth; the right-edge fade + ▾ overflow button
  // appear only when the user actually has more tabs than fit. Re-runs
  // whenever the tabs change too (track tabStore.tabs.length).
  let hasOverflow = $state(false);
  let showOverflowMenu = $state(false);

  function recomputeOverflow() {
    if (!tabListEl) return;
    hasOverflow = tabListEl.scrollWidth > tabListEl.clientWidth + 1;
  }

  $effect(() => {
    if (!tabListEl) return;
    // Read tabs.length so the effect re-runs on add/remove.
    void tabStore.tabs.length;
    recomputeOverflow();
    const ro = new ResizeObserver(() => recomputeOverflow());
    ro.observe(tabListEl);
    return () => ro.disconnect();
  });

  function handleOverflowOutsideClick(e: MouseEvent) {
    if (!showOverflowMenu) return;
    const target = e.target as HTMLElement;
    if (!target.closest('.tabbar-overflow-wrapper')) {
      showOverflowMenu = false;
    }
  }

  $effect(() => {
    if (!showOverflowMenu) return;
    document.addEventListener('click', handleOverflowOutsideClick, true);
    return () => document.removeEventListener('click', handleOverflowOutsideClick, true);
  });

  function pickOverflowTab(tabId: string) {
    showOverflowMenu = false;
    tabStore.setActive(tabId);
    // Scroll the activated tab into view so the user can see what they picked.
    requestAnimationFrame(() => {
      if (!tabListEl) return;
      const el = tabListEl.querySelector<HTMLElement>(`#tab-${tabId}`);
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  /**
   * ArrowLeft / ArrowRight move focus across tabs (WAI-ARIA tablist
   * convention); Home / End jump to first / last.
   *
   * Alt+ArrowLeft / Alt+ArrowRight reorder the currently focused tab —
   * the keyboard equivalent of drag-drop reordering.
   */
  function handleTabListKeydown(e: KeyboardEvent) {
    if (!tabListEl) return;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return;
      const tabs = Array.from(
        tabListEl.querySelectorAll<HTMLElement>('[role="tab"]'),
      );
      const idx = tabs.indexOf(active);
      if (idx === -1) return;
      const target = e.key === 'ArrowLeft' ? idx - 1 : idx + 1;
      if (target < 0 || target >= tabs.length) return;
      e.preventDefault();
      tabStore.reorder(idx, target);
      // After reorder, refocus the moved tab so the user can keep pressing.
      requestAnimationFrame(() => {
        const reordered = Array.from(
          tabListEl?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
        );
        reordered[target]?.focus();
      });
      return;
    }
    if (handleListKeyNav(e, tabListEl, { selector: '[role="tab"]', orientation: 'horizontal' })) {
      e.preventDefault();
    }
  }
</script>

<div class="tab-bar" style="height: calc(36px * var(--ui-tabbar-scale, 1));">
  <button
    class="board-browser-btn"
    onclick={openBoardBrowser}
    title="Board Browser"
    aria-label="Open Board Browser"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  </button>

  <div
    class="tab-list-wrap"
    class:has-overflow={hasOverflow}
  >
    <div
      bind:this={tabListEl}
      class="tab-list"
      role="tablist"
      aria-label="Open boards"
      tabindex={-1}
      onkeydown={handleTabListKeydown}
      onscroll={recomputeOverflow}
    >
      {#each tabStore.tabs as tab (tab.id)}
        <Tab {tab} />
      {/each}
    </div>
  </div>

  {#if hasOverflow}
    <div class="tabbar-overflow-wrapper">
      <button
        bind:this={overflowBtnEl}
        class="tabbar-overflow-btn"
        onclick={() => (showOverflowMenu = !showOverflowMenu)}
        onkeydown={(e) => { if (e.key === 'Escape' && showOverflowMenu) { e.preventDefault(); closeOverflowMenu(); } }}
        title="Show all open tabs"
        aria-label="Show all open tabs"
        aria-expanded={showOverflowMenu}
        aria-haspopup="menu"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {#if showOverflowMenu}
        <div
          class="tabbar-overflow-menu"
          role="menu"
          tabindex="-1"
          onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeOverflowMenu(); } }}
        >
          {#each tabStore.tabs as tab (tab.id)}
            <button
              class="tabbar-overflow-item"
              class:active={tab.id === tabStore.activeTabId}
              role="menuitem"
              onclick={() => pickOverflowTab(tab.id)}
              title={tab.name}
            >
              {#if tab.emoji}<span class="overflow-emoji" aria-hidden="true">{tab.emoji}</span>{/if}
              <span class="overflow-name">{tab.name}</span>
              {#if tab.id === tabStore.activeTabId}
                <span class="overflow-active-dot" aria-label="Active" title="Active"></span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <div class="new-tab-wrapper">
    <button
      bind:this={newTabBtnEl}
      class="new-tab-btn"
      onclick={() => showNewTabMenu = !showNewTabMenu}
      onkeydown={(e) => { if (e.key === 'Escape' && showNewTabMenu) { e.preventDefault(); closeNewTabMenu(); } }}
      title="New Tab"
      aria-label="New tab"
      aria-haspopup="menu"
      aria-expanded={showNewTabMenu}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>

    {#if showNewTabMenu}
      <div
        class="new-tab-menu"
        role="menu"
        tabindex="-1"
        onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeNewTabMenu(); } }}
      >
        {#each boardTypes as bt (bt.type)}
          <button class="new-tab-option" role="menuitem" onclick={() => createQuickBoard(bt.type)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d={bt.icon}/>
            </svg>
            <span>{bt.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .tab-bar {
    display: flex;
    align-items: flex-end;
    padding: 0 8px;
    background: var(--tabbar-bg);
    border-top: 1px solid var(--tabbar-border);
    flex-shrink: 0;
    overflow: visible;
    position: relative;
    gap: 2px;
  }

  .board-browser-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .board-browser-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .tab-list-wrap {
    position: relative;
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    align-items: flex-end;
  }

  .tab-list {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    flex: 0 1 auto;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0 4px;
    scrollbar-width: none;
  }

  .tab-list::-webkit-scrollbar {
    display: none;
  }

  /* Right-edge fade gradient cues "there are more tabs scrolled off". */
  .tab-list-wrap.has-overflow::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 24px;
    pointer-events: none;
    background: linear-gradient(to right, transparent, var(--tabbar-bg));
  }

  .tabbar-overflow-wrapper {
    position: relative;
    flex-shrink: 0;
  }

  .tabbar-overflow-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 28px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .tabbar-overflow-btn:hover,
  .tabbar-overflow-btn[aria-expanded='true'] {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .tabbar-overflow-menu {
    position: absolute;
    bottom: 100%;
    right: 0;
    margin-bottom: 4px;
    min-width: 220px;
    max-width: 320px;
    max-height: 50vh;
    overflow-y: auto;
    padding: 4px 0;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
    z-index: var(--z-modal-above);
    animation: popIn 0.12s ease;
  }

  .tabbar-overflow-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .tabbar-overflow-item:hover {
    background: var(--ui-surface-hover);
  }

  .tabbar-overflow-item.active {
    background: var(--ui-surface-active);
    font-weight: 600;
  }

  .overflow-emoji {
    flex-shrink: 0;
    font-size: 14px;
  }

  .overflow-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .overflow-active-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-primary);
  }

  .new-tab-wrapper {
    position: relative;
    flex-shrink: 0;
  }

  .new-tab-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .new-tab-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .new-tab-menu {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    min-width: 160px;
    padding: 4px 0;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
    z-index: var(--z-modal-above);
    animation: popIn 0.15s ease;
  }

  .new-tab-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.1s ease;
  }

  .new-tab-option:hover {
    background: var(--ui-surface-hover);
  }

  .new-tab-option svg {
    color: var(--text-secondary);
    flex-shrink: 0;
  }
</style>
