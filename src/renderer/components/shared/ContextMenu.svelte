<script lang="ts">
  import { uiStore, type ContextMenuItem } from '../../stores/ui.svelte';
  import { clampToViewport } from '../../lib/utils/popupAnchor';

  let menuEl = $state<HTMLDivElement | null>(null);
  let focusedIndex = $state(-1);
  // Rendered position. Seeded from the store's pre-paint estimate, then
  // refined against the menu's *measured* size once mounted (L4b).
  let posX = $state(0);
  let posY = $state(0);
  // Element that held focus when the menu opened. Restored when the
  // menu closes so keyboard users return to where they were
  // (spec requirement for ContextMenu accessibility).
  let triggerEl: HTMLElement | null = null;

  const menu = $derived(uiStore.contextMenu);
  const actionItems = $derived(menu.items.filter((item) => !item.divider && !item.heading));
  const hasCheckable = $derived(menu.items.some((item) => item.checked !== undefined));
  // One item with an icon gives every item an icon slot, so the labels line up.
  const hasIcons = $derived(actionItems.some((item) => item.icon));
  const blocks = $derived(menuBlocks(menu.items));

  type MenuBlock =
    | { kind: 'divider'; item: ContextMenuItem }
    | { kind: 'item'; item: ContextMenuItem }
    | { kind: 'group'; heading: ContextMenuItem; items: ContextMenuItem[] };

  /**
   * A heading names the items under it, up to the next divider or heading.
   * They render as a `group` labelled by the heading, so a screen reader says
   * "3 cards selected" on entering them, while the heading itself is never a
   * focus stop.
   */
  function menuBlocks(items: ContextMenuItem[]): MenuBlock[] {
    const out: MenuBlock[] = [];
    let group: { kind: 'group'; heading: ContextMenuItem; items: ContextMenuItem[] } | null = null;
    for (const item of items) {
      if (item.heading) {
        group = { kind: 'group', heading: item, items: [] };
        out.push(group);
      } else if (item.divider) {
        group = null;
        out.push({ kind: 'divider', item });
      } else if (group) {
        group.items.push(item);
      } else {
        out.push({ kind: 'item', item });
      }
    }
    return out;
  }

  function handleItemClick(item: ContextMenuItem) {
    if (item.disabled) return;
    item.action?.();
    uiStore.hideContextMenu();
  }

  /**
   * Skip disabled items on
   * arrow-key nav so a fully-disabled stretch of menu doesn't trap focus
   * on an unactionable row. Walks at most `actionItems.length` steps in
   * the requested direction; if every item is disabled, the focus stays
   * put.
   */
  function nextEnabledIndex(start: number, dir: 1 | -1): number {
    if (actionItems.length === 0) return -1;
    let idx = start;
    for (let i = 0; i < actionItems.length; i++) {
      idx = (idx + dir + actionItems.length) % actionItems.length;
      if (!actionItems[idx]?.disabled) return idx;
    }
    return start;
  }

  function firstEnabledIndex(): number {
    for (let i = 0; i < actionItems.length; i++) {
      if (!actionItems[i]?.disabled) return i;
    }
    return -1;
  }

  function lastEnabledIndex(): number {
    for (let i = actionItems.length - 1; i >= 0; i--) {
      if (!actionItems[i]?.disabled) return i;
    }
    return -1;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!menu.visible) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusedIndex = nextEnabledIndex(focusedIndex < 0 ? -1 : focusedIndex, 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusedIndex = nextEnabledIndex(focusedIndex < 0 ? 0 : focusedIndex, -1);
        break;
      case 'Home':
        e.preventDefault();
        focusedIndex = firstEnabledIndex();
        break;
      case 'End':
        e.preventDefault();
        focusedIndex = lastEnabledIndex();
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < actionItems.length) {
          const item = actionItems[focusedIndex];
          if (item) handleItemClick(item);
        }
        break;
      case 'Escape':
        e.preventDefault();
        uiStore.hideContextMenu();
        break;
    }
  }

  function handleBackdropClick() {
    uiStore.hideContextMenu();
  }

  // Capture-phase window listener so Escape closes the menu even when
  // focus has been stolen by a child element (e.g. a TipTap editor inside
  // a context-menu-bearing tile). Without this, escape only fired from the
  // overlay/menu div keydown handlers.
  function handleWindowKeydown(e: KeyboardEvent) {
    if (!menu.visible || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    uiStore.hideContextMenu();
  }

  $effect(() => {
    if (menu.visible) {
      // Seed from the store's pre-paint estimate so the first frame is roughly
      // right; the rAF below refines it against the real rendered size.
      posX = menu.x;
      posY = menu.y;
      // Open on the first ENABLED item so a leading disabled
      // row doesn't grab initial focus.
      focusedIndex = firstEnabledIndex();
      // Capture the previously-focused element so we can restore it on close.
      triggerEl = (document.activeElement as HTMLElement | null) ?? null;
      // Focus the menu now, not in the frame below: a key pressed before that
      // frame would otherwise go to whatever opened the menu (the sidebar
      // tree moves its own focus on an arrow) and be lost to the menu.
      menuEl?.focus();
      // Reposition using the measured size so a menu opened near a viewport
      // edge isn't clipped (the store's items×32 height guess under-counts
      // real row height + padding).
      requestAnimationFrame(() => {
        if (menuEl) {
          const rect = menuEl.getBoundingClientRect();
          const clamped = clampToViewport(
            menu.x,
            menu.y,
            rect.width,
            rect.height,
            window.innerWidth,
            window.innerHeight,
          );
          posX = clamped.x;
          posY = clamped.y;
        }
      });
      window.addEventListener('keydown', handleWindowKeydown, true);
      return () => {
        window.removeEventListener('keydown', handleWindowKeydown, true);
        // Restore focus when the menu closes (keyboard users return to
        // the element they were on before opening the menu).
        if (triggerEl && document.contains(triggerEl)) {
          try { triggerEl.focus(); } catch { /* element no longer focusable */ }
        }
        triggerEl = null;
      };
    }
  });
</script>

{#if menu.visible}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="context-overlay" onclick={handleBackdropClick} onkeydown={handleKeydown}></div>
  <div
    class="context-menu"
    role="menu"
    tabindex="-1"
    bind:this={menuEl}
    onkeydown={handleKeydown}
    style="left: {posX}px; top: {posY}px;"
  >
    {#snippet menuItem(item: ContextMenuItem)}
      {@const actionIdx = actionItems.indexOf(item)}
      {@const isCheckable = item.checked !== undefined}
      <button
        class="menu-item"
        class:danger={item.danger}
        class:disabled={item.disabled}
        class:focused={actionIdx === focusedIndex}
        role={isCheckable ? 'menuitemcheckbox' : 'menuitem'}
        aria-checked={isCheckable ? item.checked : undefined}
        aria-disabled={item.disabled}
        onclick={() => handleItemClick(item)}
      >
        {#if hasCheckable}
          <span class="menu-check" aria-hidden="true">
            {#if item.checked}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            {/if}
          </span>
        {/if}
        {#if item.icon}
          <svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d={item.icon}/>
          </svg>
        {:else if hasIcons}
          <span class="menu-icon-slot" aria-hidden="true"></span>
        {/if}
        <span class="menu-label">{item.label}</span>
        {#if item.shortcut}
          <span class="menu-shortcut">{item.shortcut}</span>
        {/if}
      </button>
    {/snippet}
    {#each blocks as block, i (`${block.kind === 'group' ? block.heading.id : block.item.id}_${i}`)}
      {#if block.kind === 'divider'}
        <div class="menu-divider" role="separator"></div>
      {:else if block.kind === 'group'}
        {@const headingId = `context-menu-heading-${i}`}
        <div class="menu-group" role="group" aria-labelledby={headingId}>
          <div class="menu-heading" id={headingId} role="presentation">{block.heading.label}</div>
          {#each block.items as item, j (`${item.id}_${j}`)}
            {@render menuItem(item)}
          {/each}
        </div>
      {:else}
        {@render menuItem(block.item)}
      {/if}
    {/each}
  </div>
  <div class="sr-announcer" aria-live="polite" role="status">
    {#if focusedIndex >= 0 && focusedIndex < actionItems.length}
      {actionItems[focusedIndex]?.label}
    {/if}
  </div>
{/if}

<style>
  .sr-announcer {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    border: 0;
  }
  .context-overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-context-menu-overlay);
  }

  .context-menu {
    position: fixed;
    z-index: var(--z-context-menu);
    min-width: 180px;
    padding: 4px 0;
    background: var(--menu-bg);
    border: 1px solid var(--menu-border);
    border-radius: 6px;
    box-shadow: var(--ui-shadow-lg);
    outline: none;
    animation: popIn 0.1s ease;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 16px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .menu-item:hover,
  .menu-item.focused {
    background: var(--menu-hover);
  }

  .menu-item.danger {
    color: var(--menu-danger);
  }

  .menu-item.danger:hover,
  .menu-item.danger.focused {
    background: var(--menu-danger-bg);
  }

  .menu-item.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .menu-item.disabled:hover {
    background: transparent;
  }

  .menu-icon {
    flex-shrink: 0;
    opacity: 0.7;
  }

  .menu-icon-slot {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  .menu-check {
    display: inline-flex;
    width: 16px;
    height: 16px;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--accent-primary);
  }

  .menu-label {
    flex: 1;
  }

  .menu-shortcut {
    margin-left: 24px;
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .menu-heading {
    padding: 4px 12px 2px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    user-select: none;
  }

  .menu-divider {
    height: 1px;
    margin: 4px 0;
    background: var(--ui-border);
  }

  @media (prefers-reduced-motion: reduce) {
    .context-menu {
      animation: none;
    }
  }
</style>
