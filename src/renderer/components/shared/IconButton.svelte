<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    onclick?: (e: MouseEvent) => void;
    title?: string;
    ariaLabel?: string;
    active?: boolean;
    /** When defined, exposes `aria-pressed` (use for toggle buttons). */
    pressed?: boolean | undefined;
    disabled?: boolean;
    danger?: boolean;
    size?: 'small' | 'medium' | 'large';
    children: Snippet;
  }

  let {
    onclick,
    title = '',
    ariaLabel = '',
    active = false,
    pressed = undefined,
    disabled = false,
    danger = false,
    size = 'medium',
    children,
  }: Props = $props();

  const sizeMap = { small: 24, medium: 28, large: 32 };
</script>

<button
  class="icon-btn"
  class:active
  class:danger
  class:disabled
  style="width: {sizeMap[size]}px; height: {sizeMap[size]}px;"
  onmousedown={(e) => e.preventDefault()}
  {onclick}
  {title}
  aria-label={ariaLabel || title}
  aria-pressed={pressed === undefined ? undefined : pressed}
  {disabled}
>
  {@render children()}
</button>

<style>
  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--chrome-fg-muted, var(--text-secondary));
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease;
    flex-shrink: 0;
  }

  .icon-btn:hover:not(.disabled) {
    background: var(--chrome-hover, var(--ui-surface-hover));
    color: var(--chrome-fg, var(--text-primary));
  }

  .icon-btn:active:not(.disabled) {
    background: var(--ui-surface-active);
  }

  .icon-btn.active {
    background: var(--ui-surface-active);
    color: var(--accent-primary);
  }

  .icon-btn.danger:hover:not(.disabled) {
    background: var(--menu-danger-bg);
    color: var(--accent-danger);
  }

  .icon-btn.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
