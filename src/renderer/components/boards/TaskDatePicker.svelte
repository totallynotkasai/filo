<script lang="ts">
  /**
   * TaskDatePicker — small floating date picker popover.
   *
   * Pure presentational: receives the current value + an anchor (screen-
   * relative {x, y}) and emits {value, time?} on selection. Closes itself
   * via `onClose` when the user picks, clicks Clear, hits Escape, or
   * clicks outside.
   *
   * Optional `withTime` exposes an HH:MM input below the grid so the
   * caller can replace both the date and time in one round trip — the
   * dueDate popover uses this for combined edits.
   */
  import { portal } from '../../lib/utils/portal';
  import { tick } from 'svelte';
  import { SvelteDate } from 'svelte/reactivity';
  import { DatePickerViewState } from '../../lib/tasklist/datePickerViewState.svelte';
  let {
    value,
    time = '',
    anchor,
    withTime = false,
    label = 'Pick a date',
    onPick,
    onPickTime,
    onClear,
    onClose,
  }: {
    value: string;
    time?: string;
    anchor: { x: number; y: number };
    withTime?: boolean;
    label?: string;
    onPick: (iso: string) => void;
    onPickTime?: (time: string) => void;
    onClear: () => void;
    onClose: () => void;
  } = $props();

  function toIso(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function todayIso(): string {
    return toIso(new Date());
  }

  function dateNDaysFromNow(days: number): string {
    const d = new SvelteDate();
    d.setDate(d.getDate() + days);
    return toIso(d);
  }

  // View month/year is owned by DatePickerViewState so the "seed once per value,
  // never reset on navigation" logic (DATE-1) is unit-tested in isolation — the
  // repo's vitest setup can't mount a Svelte component that has a scoped style
  // block.
  const view = new DatePickerViewState();
  $effect(() => {
    // Reads ONLY `value`; the view-state decides whether `value` actually
    // changed before re-seeding, so the ‹/› arrows (which mutate the view but
    // not `value`) are never clobbered by this effect.
    view.syncToValue(value);
  });

  let monthLabel = $derived(
    new Date(view.viewYear, view.viewMonth, 1).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    }),
  );

  interface GridCell {
    iso: string;
    day: number;
    inMonth: boolean;
    isToday: boolean;
    isSelected: boolean;
  }

  // Calendar grid: 6 rows × 7 columns, padded so the first cell is the
  // Sunday on or before the 1st of the visible month.
  let grid = $derived.by<GridCell[]>(() => {
    const first = new Date(view.viewYear, view.viewMonth, 1);
    const startOffset = first.getDay(); // 0 = Sun
    const start = new Date(view.viewYear, view.viewMonth, 1 - startOffset);
    const today = todayIso();
    const cells: GridCell[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new SvelteDate(start);
      d.setDate(start.getDate() + i);
      const iso = toIso(d);
      cells.push({
        iso,
        day: d.getDate(),
        inMonth: d.getMonth() === view.viewMonth,
        isToday: iso === today,
        isSelected: iso === value,
      });
    }
    return cells;
  });

  const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  function handlePick(iso: string) {
    onPick(iso);
    onClose();
  }

  function handleClear() {
    onClear();
    onClose();
  }

  function handleTimeInput(e: Event) {
    const t = (e.currentTarget as HTMLInputElement).value;
    // DATE-2 — refuse an orphan time (a dueTime with no dueDate is invisible:
    // the chip only renders inside `{#if dueDate}`). The input is also disabled
    // when there's no date, so this is a belt-and-suspenders guard.
    if (!value) return;
    onPickTime?.(t);
  }

  let popoverEl: HTMLDivElement | undefined = $state();

  function onPopoverKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function onBackdropClick(e: MouseEvent) {
    if (popoverEl && !popoverEl.contains(e.target as Node)) {
      onClose();
    }
  }

  // Clamp the popover into the viewport so it never spills off the
  // bottom-right edge. Initial estimates are deliberately conservative;
  // an effect below re-measures the actual rendered rect after first
  // paint so the clamp respects the true height (the time row adds ~40px,
  // and theme tweaks can shift the totals).
  let measuredW = $state(240);
  let measuredH = $state(320);

  let style = $derived.by(() => {
    const x = Math.min(Math.max(8, anchor.x), window.innerWidth - measuredW - 8);
    const y = Math.min(Math.max(8, anchor.y), window.innerHeight - measuredH - 8);
    return `top: ${y}px; left: ${x}px;`;
  });

  // Re-measure after mount so the clamp uses the true rendered size. The
  // anchor itself can also change (caller may re-open the popover from a
  // different chip) — track it as a dependency so we re-measure.
  $effect(() => {
    void anchor;
    void withTime;
    void tick().then(() => {
      if (!popoverEl) return;
      const r = popoverEl.getBoundingClientRect();
      if (r.width > 0) measuredW = r.width;
      if (r.height > 0) measuredH = r.height;
    });
  });
</script>

<div
  use:portal
  class="date-popover-backdrop"
  role="presentation"
  onclick={onBackdropClick}
  onkeydown={onPopoverKeydown}
  tabindex="-1"
>
  <div
    bind:this={popoverEl}
    class="date-popover"
    role="group"
    aria-label={label}
    tabindex="-1"
    {style}
  >
    <div class="quick-chips">
      <button class="chip" onclick={() => handlePick(todayIso())}>Today</button>
      <button class="chip" onclick={() => handlePick(dateNDaysFromNow(1))}>Tomorrow</button>
      <button class="chip" onclick={() => handlePick(dateNDaysFromNow(7))}>Next week</button>
    </div>

    <div class="month-header">
      <button class="nav-btn" onclick={() => view.prevMonth()} aria-label="Previous month">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <span class="month-label">{monthLabel}</span>
      <button class="nav-btn" onclick={() => view.nextMonth()} aria-label="Next month">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    </div>

    <div class="weekday-row" aria-hidden="true">
      {#each WEEKDAY_LABELS as wd, i (i)}
        <span class="weekday">{wd}</span>
      {/each}
    </div>

    <div class="day-grid" role="grid" aria-label="Calendar">
      {#each grid as cell (cell.iso)}
        <button
          class="day-cell"
          class:out-of-month={!cell.inMonth}
          class:is-today={cell.isToday}
          class:is-selected={cell.isSelected}
          onclick={() => handlePick(cell.iso)}
          aria-label={cell.iso}
          aria-pressed={cell.isSelected}
        >
          {cell.day}
        </button>
      {/each}
    </div>

    {#if withTime}
      <div class="time-row">
        <label class="time-label" for="task-due-time-input">Time</label>
        <input
          id="task-due-time-input"
          type="time"
          class="time-input"
          value={time}
          disabled={!value}
          title={value ? '' : 'Pick a date first'}
          onchange={handleTimeInput}
        />
        {#if time}
          <button
            class="time-clear"
            onclick={() => onPickTime?.('')}
            aria-label="Clear time"
          ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        {/if}
      </div>
    {/if}

    <div class="footer">
      {#if value}
        <button class="clear-btn" onclick={handleClear}>Clear</button>
      {/if}
      <button class="close-btn" onclick={onClose}>Done</button>
    </div>
  </div>
</div>

<style>
  .date-popover-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
  }

  .date-popover {
    position: fixed;
    width: 240px;
    padding: 8px;
    background: var(--menu-bg);
    border: 1px solid var(--menu-border);
    border-radius: 8px;
    box-shadow: var(--ui-shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: popIn 0.12s ease;
  }

  .quick-chips {
    display: flex;
    gap: 4px;
  }

  .chip {
    flex: 1;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--text-primary);
    background: var(--ui-surface-hover);
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .chip:hover {
    background: var(--ui-surface-active);
    border-color: var(--ui-border-light);
  }

  .month-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }

  .month-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .nav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .nav-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .weekday-row {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
  }

  .weekday {
    text-align: center;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-tertiary);
    padding: 2px 0;
  }

  .day-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
  }

  .day-cell {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-primary);
    font-size: 11px;
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .day-cell:hover {
    background: var(--ui-surface-hover);
  }

  .day-cell.out-of-month {
    color: var(--text-tertiary);
    opacity: 0.5;
  }

  .day-cell.is-today {
    color: var(--accent-primary);
    font-weight: 700;
  }

  .day-cell.is-selected {
    background: var(--accent-primary);
    color: var(--text-inverse, #fff);
  }

  .time-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 2px;
    border-top: 1px solid var(--ui-border-light);
  }

  .time-label {
    font-size: 11px;
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .time-input {
    flex: 1;
    font-size: 12px;
    color: var(--text-primary);
    background: var(--ui-surface-raised);
    border: 1px solid var(--ui-border-light);
    border-radius: 4px;
    padding: 2px 6px;
  }

  .time-input:focus {
    border-color: var(--ui-border-focus, var(--accent-primary));
  }

  .time-input:focus:not(:focus-visible) {
    outline: none;
  }

  .time-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .time-clear {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
  }

  .time-clear:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .footer {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--ui-border-light);
  }

  .clear-btn,
  .close-btn {
    padding: 4px 10px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    cursor: pointer;
  }

  .clear-btn {
    color: var(--accent-danger);
  }

  .clear-btn:hover {
    background: var(--menu-danger-bg, rgba(255, 107, 107, 0.1));
  }

  .close-btn:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

</style>
