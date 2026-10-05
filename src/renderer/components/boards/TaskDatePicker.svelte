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
   *
   * Keyboard: it opens with focus on the chosen day (else today); the arrows
   * move a day or a week, Home / End to the week's ends, Page Up / Page Down
   * a month, Enter or Space picks, Escape closes. Focus stays inside while it
   * is open and goes back where it was when it closes. The week starts on the
   * OS regional format's first day, and each day is read out in full.
   */
  import { portal } from '../../lib/utils/portal';
  import { tick, untrack } from 'svelte';
  import { createFocusTrap, type FocusTrap } from 'focus-trap';
  import { safeDeactivateTrap } from '../../lib/utils/focusTrapSafe';
  import { displayLocale, formatDayLong, localIsoDate, localIsoDateInDays } from '../../lib/utils/dateFormat';
  import { DatePickerViewState } from '../../lib/tasklist/datePickerViewState.svelte';
  import { dateKeyMove, weekdayLabels, weekStartDay } from '../../lib/tasklist/calendarGrid';
  import { clockStore } from '../../stores/clock.svelte';
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


  // View month/year is owned by DatePickerViewState so the "seed once per value,
  // never reset on navigation" logic is unit-tested in isolation — the
  // repo's vitest setup can't mount a Svelte component that has a scoped style
  // block.
  const view = new DatePickerViewState();
  $effect(() => {
    // Reads ONLY `value`; the view-state decides whether `value` actually
    // changed before re-seeding, so the ‹/› arrows (which mutate the view but
    // not `value`) are never clobbered by this effect.
    view.syncToValue(value);
  });

  const locale = displayLocale();
  const weekStart = weekStartDay(locale);
  const WEEKDAY_LABELS = weekdayLabels(weekStart, locale);

  let monthLabel = $derived(
    new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(view.viewYear, view.viewMonth, 1)),
  );

  interface GridCell {
    iso: string;
    day: number;
    inMonth: boolean;
    isToday: boolean;
    isSelected: boolean;
    /** The day in full, for a screen reader ("Monday, 12 October 2026, today"). */
    label: string;
  }

  // Calendar grid: 6 weeks × 7 days from the locale's first weekday on or
  // before the 1st of the visible month.
  let grid = $derived.by<GridCell[]>(() => {
    const today = localIsoDate(clockStore.todayDate());
    const monthPrefix = `${view.viewYear}-${String(view.viewMonth + 1).padStart(2, '0')}-`;
    return view.cells(weekStart).map((iso) => ({
      iso,
      day: Number(iso.slice(8)),
      inMonth: iso.startsWith(monthPrefix),
      isToday: iso === today,
      isSelected: iso === value,
      label: `${formatDayLong(iso, { locale })}${iso === today ? ', today' : ''}`,
    }));
  });

  let gridEl: HTMLDivElement | undefined = $state();

  function focusDay(): void {
    gridEl?.querySelector<HTMLButtonElement>(`[data-iso="${view.focusedIso}"]`)?.focus();
  }

  function onGridKeydown(e: KeyboardEvent): void {
    const move = dateKeyMove(e.key, view.focusedIso, weekStart);
    if (!move) return;
    e.preventDefault();
    view.move(move);
    void tick().then(focusDay);
  }

  function handlePick(iso: string) {
    onPick(iso);
    close();
  }

  function handleClear() {
    timeDraft = null;
    onClear();
    close();
  }

  // The time box holds what is typed and saves it once (Enter, leaving the
  // box, or closing the picker): Chromium fires a change at every part of a
  // time typed, which was an undo step per keystroke.
  let timeDraft = $state<string | null>(null);

  function commitTime(): void {
    const t = timeDraft;
    timeDraft = null;
    // Refuse an orphan time (a dueTime with no dueDate is invisible:
    // the chip only renders inside `{#if dueDate}`). The input is also disabled
    // when there's no date, so this is a belt-and-suspenders guard.
    if (t === null || t === time || !value) return;
    onPickTime?.(t);
  }

  function onTimeKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTime();
    }
  }

  function close(): void {
    commitTime();
    onClose();
  }

  let popoverEl: HTMLDivElement | undefined = $state();

  function onPopoverKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // Kept from the row (and the app's Escape) behind it.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  // Focus moves in on the keyboard's day and stays inside while the picker is
  // open; closing hands it back to what had it (the row, or the date chip).
  $effect(() => {
    const el = popoverEl;
    if (!el) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const trap: FocusTrap = createFocusTrap(el, {
      escapeDeactivates: false,
      clickOutsideDeactivates: false,
      allowOutsideClick: true,
      returnFocusOnDeactivate: false,
      initialFocus: () => gridEl?.querySelector<HTMLButtonElement>('[tabindex="0"]') ?? el,
      fallbackFocus: el,
      preventScroll: true,
    });
    untrack(() => {
      try {
        trap.activate();
      } catch {
        // No tabbable node yet: the day is focused below all the same.
      }
      // The trap's own first focus skips a node it judges hidden (before
      // layout); the keyboard's day is where focus belongs.
      focusDay();
    });
    return () => {
      safeDeactivateTrap(trap, { name: 'TaskDatePicker' });
      if (previouslyFocused?.isConnected) {
        queueMicrotask(() => {
          if (previouslyFocused.isConnected) previouslyFocused.focus();
        });
      }
    };
  });

  function onBackdropClick(e: MouseEvent) {
    if (popoverEl && !popoverEl.contains(e.target as Node)) {
      close();
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
      <button class="chip" onclick={() => handlePick(localIsoDateInDays(0))}>Today</button>
      <button class="chip" onclick={() => handlePick(localIsoDateInDays(1))}>Tomorrow</button>
      <button class="chip" onclick={() => handlePick(localIsoDateInDays(7))}>Next week</button>
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
        <span class="weekday" title={wd.long}>{wd.narrow}</span>
      {/each}
    </div>

    <!-- One Tab stop: the keyboard's day; the arrows move between days. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="day-grid" role="group" aria-label={monthLabel} bind:this={gridEl} onkeydown={onGridKeydown}>
      {#each grid as cell (cell.iso)}
        <button
          class="day-cell"
          class:out-of-month={!cell.inMonth}
          class:is-today={cell.isToday}
          class:is-selected={cell.isSelected}
          data-iso={cell.iso}
          tabindex={cell.iso === view.focusedIso ? 0 : -1}
          onclick={() => handlePick(cell.iso)}
          onfocus={() => (view.focusedIso = cell.iso)}
          aria-label={cell.label}
          aria-current={cell.isToday ? 'date' : undefined}
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
          value={timeDraft ?? time}
          disabled={!value}
          title={value ? '' : 'Pick a date first'}
          oninput={(e) => (timeDraft = (e.currentTarget as HTMLInputElement).value)}
          onchange={(e) => (timeDraft = (e.currentTarget as HTMLInputElement).value)}
          onblur={commitTime}
          onkeydown={onTimeKeydown}
        />
        {#if time}
          <button
            class="time-clear"
            onclick={() => { timeDraft = null; onPickTime?.(''); }}
            aria-label="Clear time"
          ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        {/if}
      </div>
    {/if}

    <div class="footer">
      {#if value}
        <button class="clear-btn" onclick={handleClear}>Clear</button>
      {/if}
      <button class="close-btn" onclick={close}>Done</button>
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

  .day-cell:focus-visible {
    outline: 2px solid var(--ui-border-focus, var(--accent-primary));
    outline-offset: -2px;
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
