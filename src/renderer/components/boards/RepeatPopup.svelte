<script lang="ts">
  /**
   * RepeatPopup — the Repeat menu's "Every…": a task repeats every N days,
   * weeks, months or years. Opens beside the menu with the number selected;
   * Enter or Save sets the rule, Escape or Cancel leaves it, and focus goes
   * back where it was. Focus stays inside while it is open: the menu that
   * opened it hands focus back to the chip as it closes, which would leave
   * the keys (Escape too) outside.
   */
  import { untrack } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';
  import { portal } from '../../lib/utils/portal';
  import { everyRule, parseRecurrence } from '../../lib/tasks/recurrence';

  let {
    recurrence,
    anchor,
    onSave,
    onClose,
  }: {
    /** The task's rule, to start from when it is an "every N" one. */
    recurrence: string;
    anchor: { x: number; y: number };
    onSave: (rule: string) => void;
    onClose: () => void;
  } = $props();

  type Unit = 'd' | 'w' | 'm' | 'y';
  const UNITS: ReadonlyArray<{ unit: Unit; label: string }> = [
    { unit: 'd', label: 'days' },
    { unit: 'w', label: 'weeks' },
    { unit: 'm', label: 'months' },
    { unit: 'y', label: 'years' },
  ];

  // The rule the popup opens on; edits after that are the popup's own.
  const start = untrack(() => parseRecurrence(recurrence));
  let count = $state(start?.kind === 'fixed' ? start.count : 2);
  let unit = $state<Unit>(start?.kind === 'fixed' ? start.unit : 'w');
  let valid = $derived(Number.isInteger(count) && count >= 1 && count <= 999);

  let countEl: HTMLInputElement | undefined = $state();
  let popupEl: HTMLDivElement | undefined = $state();
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  $effect(() => {
    const el = popupEl;
    if (!el) return;
    const trap: FocusTrap = createFocusTrap(el, {
      escapeDeactivates: false,
      clickOutsideDeactivates: false,
      allowOutsideClick: true,
      returnFocusOnDeactivate: false,
      initialFocus: () => countEl ?? el,
      fallbackFocus: el,
      preventScroll: true,
    });
    untrack(() => {
      try {
        trap.activate();
      } catch {
        // Nothing tabbable yet: the number is focused below all the same.
      }
      countEl?.focus();
      countEl?.select();
    });
    return () => {
      safeDeactivateTrap(trap, { name: 'RepeatPopup' });
      if (previouslyFocused?.isConnected) queueMicrotask(() => previouslyFocused.focus());
    };
  });

  function save(): void {
    if (!valid) return;
    onSave(everyRule(count, unit));
    onClose();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  let style = $derived(
    `top: ${Math.min(Math.max(8, anchor.y), window.innerHeight - 140)}px; left: ${Math.min(Math.max(8, anchor.x), window.innerWidth - 248)}px;`,
  );
</script>

<div use:portal class="repeat-backdrop" role="presentation" onclick={onClose}></div>
<div
  use:portal
  bind:this={popupEl}
  class="repeat-popup"
  role="dialog"
  aria-label="Repeat every"
  tabindex="-1"
  {style}
  onkeydown={onKeydown}
>
  <div class="repeat-row">
    <label class="repeat-label" for="repeat-every-count">Every</label>
    <input
      id="repeat-every-count"
      class="repeat-count"
      type="number"
      min="1"
      max="999"
      bind:this={countEl}
      bind:value={count}
      aria-invalid={!valid}
    />
    <select class="repeat-unit" bind:value={unit} aria-label="Unit">
      {#each UNITS as u (u.unit)}
        <option value={u.unit}>{u.label}</option>
      {/each}
    </select>
  </div>
  <div class="repeat-actions">
    <button class="repeat-btn" onclick={onClose}>Cancel</button>
    <button class="repeat-btn primary" onclick={save} disabled={!valid}>Save</button>
  </div>
</div>

<style>
  .repeat-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
  }

  .repeat-popup {
    position: fixed;
    z-index: 51;
    width: 240px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--menu-bg);
    border: 1px solid var(--menu-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
  }

  .repeat-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .repeat-label {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .repeat-count,
  .repeat-unit {
    font-size: 12px;
    color: var(--text-primary);
    background: var(--ui-surface-raised);
    border: 1px solid var(--ui-border-light);
    border-radius: 4px;
    padding: 3px 6px;
  }

  .repeat-count {
    width: 64px;
  }

  .repeat-unit {
    flex: 1;
  }

  .repeat-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .repeat-btn {
    padding: 4px 10px;
    font-size: 12px;
    border-radius: 4px;
    border: 1px solid var(--ui-border-light);
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
  }

  .repeat-btn.primary {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: var(--text-inverse);
  }

  .repeat-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
