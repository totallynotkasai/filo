<script lang="ts">
  import type { Snippet } from 'svelte';
  import { handleListKeyNav, focusFirstItem } from '../../lib/utils/listKeyNav';

  interface Props {
    label: string;
    open?: boolean;
    align?: 'left' | 'right';
    /** A colour dot before the label (the vault's colour); empty shows none. */
    swatch?: string;
    children: Snippet;
  }

  let { label, open = $bindable(false), align = 'left', swatch = '', children }: Props = $props();

  let dropdownRef = $state<HTMLDivElement | null>(null);
  let triggerRef = $state<HTMLButtonElement | null>(null);
  let panelRef = $state<HTMLDivElement | null>(null);
  // Item selector for arrow-key nav. `button` covers dropdown items;
  // role="menuitem" covers the rare case of a non-button row.
  const ITEM_SELECTOR = 'button:not([disabled]), [role="menuitem"]:not([disabled])';

  function toggle() {
    open = !open;
  }

  function handleClickOutside(e: MouseEvent) {
    if (dropdownRef && !dropdownRef.contains(e.target as Node)) {
      open = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      open = false;
      // Return focus to the trigger so the user doesn't lose their place.
      triggerRef?.focus();
      return;
    }
    if (!panelRef) return;
    if (handleListKeyNav(e, panelRef, { selector: ITEM_SELECTOR, orientation: 'vertical' })) {
      e.preventDefault();
    }
  }

  function handleTriggerKeydown(e: KeyboardEvent) {
    // ArrowDown on the closed trigger opens the menu and focuses its first
    // item — matches the WAI-ARIA Authoring Practices menu pattern.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
      e.preventDefault();
      open = true;
      // Items render after the next microtask — focus on rAF so the
      // panel is in the DOM.
      requestAnimationFrame(() => {
        if (panelRef) focusFirstItem(panelRef, ITEM_SELECTOR);
      });
    }
  }

  $effect(() => {
    if (open) {
      document.addEventListener('click', handleClickOutside, true);
      document.addEventListener('keydown', handleKeydown, true);
      return () => {
        document.removeEventListener('click', handleClickOutside, true);
        document.removeEventListener('keydown', handleKeydown, true);
      };
    }
  });
</script>

<div class="dropdown-wrapper" bind:this={dropdownRef}>
  <button
    bind:this={triggerRef}
    class="dropdown-trigger"
    onclick={toggle}
    onkeydown={handleTriggerKeydown}
    aria-expanded={open}
    aria-haspopup="menu"
    aria-label={label}
  >
    {#if swatch}
      <span class="dropdown-swatch" style:background={swatch} aria-hidden="true"></span>
    {/if}
    <span class="dropdown-label">{label}</span>
    <svg class="dropdown-chevron" class:open width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  </button>

  {#if open}
    <div
      bind:this={panelRef}
      class="dropdown-panel"
      class:align-right={align === 'right'}
      role="menu"
    >
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .dropdown-wrapper {
    position: relative;
  }

  .dropdown-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-weight: 500;
    font-family: var(--font-system);
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease;
    white-space: nowrap;
  }

  .dropdown-trigger:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .dropdown-trigger:active {
    background: var(--ui-surface-active);
  }

  .dropdown-swatch {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-right: 2px;
  }

  .dropdown-chevron {
    transition: transform 0.15s ease;
  }

  .dropdown-chevron.open {
    transform: rotate(180deg);
  }

  .dropdown-panel {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: var(--z-dropdown-panel);
    min-width: 200px;
    padding: 6px 0;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
    animation: popIn 0.12s ease;
  }

  .dropdown-panel.align-right {
    left: auto;
    right: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .dropdown-chevron,
    .dropdown-panel {
      animation: none;
      transition: none;
    }
  }
</style>
