<script lang="ts">
  import { uiStore } from '../../stores/ui.svelte';

  const typeColors = {
    info: 'var(--accent-info)',
    success: 'var(--accent-success)',
    warning: 'var(--accent-warning)',
    error: 'var(--accent-danger)',
  };

  // Phase 6.4 (IMPLEMENTATION_PLAN_2026-05-27) — non-colour state cue so
  // a colour-blind / monochrome-display user still discriminates toast
  // severity. Each type gets a small inline SVG with an `aria-label`;
  // the visual sits alongside the border-left-color and the role/
  // aria-live announcement.
  const typeLabels = {
    info: 'Info',
    success: 'Success',
    warning: 'Warning',
    error: 'Error',
  } as const;
</script>

{#if uiStore.toasts.length > 0}
  <div class="toast-container" style="z-index: var(--z-toast);">
    {#each uiStore.toasts as toast (toast.id)}
      <div
        class="toast"
        style="border-left-color: {typeColors[toast.type]};"
        role={toast.type === 'error' || toast.type === 'warning' ? 'alert' : 'status'}
        aria-live={toast.type === 'error' || toast.type === 'warning' ? 'assertive' : 'polite'}
      >
        <span class="toast-icon" style="color: {typeColors[toast.type]};" aria-label={typeLabels[toast.type]}>
          {#if toast.type === 'success'}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          {:else if toast.type === 'error'}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
          {:else if toast.type === 'warning'}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          {:else}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
          {/if}
        </span>
        <span class="toast-text">{toast.text}</span>
        {#if toast.actions && toast.actions.length > 0}
          <div class="toast-actions">
            {#each toast.actions as action, i (i)}
              <button
                class="toast-action"
                aria-label={`${action.label} — ${toast.text}`}
                onclick={() => uiStore.invokeToastAction(toast.id, i)}
              >{action.label}</button>
            {/each}
          </div>
        {/if}
        <button
          class="toast-close"
          onclick={() => uiStore.dismissToast(toast.id)}
          aria-label="Dismiss"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    bottom: 56px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: min(720px, calc(100vw - 32px));
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 20px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-left-width: 3px;
    border-radius: 6px;
    box-shadow: var(--ui-shadow-elevated);
    pointer-events: auto;
    animation: toast-in 0.3s ease-out;
    width: 100%;
    min-width: 320px;
    max-width: 100%;
  }

  .toast-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
  }

  .toast-text {
    flex: 1;
    font-size: 14px;
    color: var(--text-primary);
  }

  .toast-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color 0.1s ease;
  }

  .toast-close:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .toast-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .toast-action {
    padding: 4px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface-hover);
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .toast-action:hover {
    background: var(--ui-surface-active);
    border-color: var(--accent-primary);
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
