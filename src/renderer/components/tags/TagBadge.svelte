<script lang="ts">
  import { fileTagsStore } from '../../stores/fileTags.svelte';

  type Size = 'sm' | 'md';
  type Variant = 'solid' | 'outline';
  type AsElement = 'button' | 'span';

  let {
    tagName,
    onClick,
    size = 'md',
    variant = 'solid',
    as = 'button',
    ariaLabel,
    pressed,
  }: {
    tagName: string;
    onClick?: (e: MouseEvent) => void;
    size?: Size;
    variant?: Variant;
    /**
     * Render as a `<span>` when the badge is mounted inside another
     * interactive ancestor (e.g. a tile's clickable tag row),
     * where a nested `<button>` would be invalid HTML and break click
     * dispatch in some browsers.
     */
    as?: AsElement;
    /** Accessible name when the button does something other than show the tag. */
    ariaLabel?: string;
    /** Set for a badge that toggles something on (`aria-pressed`). */
    pressed?: boolean;
  } = $props();

  let color = $derived(fileTagsStore.getDefinition(tagName).color);
</script>

{#if as === 'span'}
  <span
    class="tag-badge as-span"
    class:size-sm={size === 'sm'}
    class:size-md={size === 'md'}
    class:variant-outline={variant === 'outline'}
    style="--tag-color: {color}"
    title={tagName}
  >
    {#if variant === 'solid'}
      <span class="color-dot"></span>
    {/if}
    <span class="tag-name">{tagName}</span>
  </span>
{:else}
  <button
    class="tag-badge"
    class:size-sm={size === 'sm'}
    class:size-md={size === 'md'}
    class:variant-outline={variant === 'outline'}
    class:pressed
    style="--tag-color: {color}"
    onclick={onClick}
    title={ariaLabel ?? tagName}
    aria-label={ariaLabel}
    aria-pressed={pressed}
  >
    {#if variant === 'solid'}
      <span class="color-dot"></span>
    {/if}
    <span class="tag-name">{tagName}</span>
  </button>
{/if}

<style>
  .tag-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--tag-gap);
    padding: var(--tag-pad-y) var(--tag-pad-x);
    border-radius: 4px;
    background: var(--ui-surface-hover);
    border: 1px solid var(--ui-border);
    cursor: pointer;
    transition: all 0.15s;
    color: var(--text-secondary);
    max-width: 120px;
    font: inherit;
  }
  /* The span variant is non-interactive — sits inside other clickable
     ancestors (e.g. the sidebar file row) where a nested button would be
     invalid HTML. */
  .tag-badge.as-span {
    cursor: inherit;
  }
  .tag-badge:hover {
    background: var(--ui-surface);
    border-color: var(--text-tertiary);
    color: var(--text-primary);
  }
  .tag-badge.size-md { font-size: var(--tag-font-size-md); }
  .tag-badge.size-sm {
    font-size: var(--tag-font-size-sm);
    padding: calc(var(--tag-pad-y) - 1px) calc(var(--tag-pad-x) - 1px);
  }

  .tag-badge.variant-outline {
    background: transparent;
    border-color: color-mix(in srgb, var(--tag-color) 40%, transparent);
    color: var(--tag-color);
  }
  .tag-badge.variant-outline:hover {
    background: color-mix(in srgb, var(--tag-color) 8%, transparent);
    border-color: var(--tag-color);
  }
  .tag-badge.variant-outline.pressed {
    background: color-mix(in srgb, var(--tag-color) 18%, transparent);
    border-color: var(--tag-color);
  }
  .tag-badge:focus-visible {
    outline: 2px solid var(--ui-border-focus);
    outline-offset: 1px;
  }

  .color-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tag-color, #6c63ff);
    flex-shrink: 0;
  }
  .tag-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
