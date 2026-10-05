<script lang="ts">
  /**
   * TaskQuickAddInput — sticky single-line input pinned above the task list.
   *
   * Parses tokens as the user types (date, time, priority, tags, status) and
   * shows a live preview strip of recognised metadata. On Enter, fires
   * `onSubmit(parsed)` with the title + structured fields and clears.
   *
   * Pure presentational: the parent owns task creation. Submission is debounced
   * only by the user pressing Enter — the parent decides what to do if title
   * is empty.
   */
  import { parseQuickAdd, type QuickAddParsed } from '../../lib/tasks/quickAddParser';
  import { localeIsDayFirst } from '../../lib/tasks/dateOrder';
  import { recurrenceLabel } from '../../lib/tasks/recurrence';
  import { formatDay } from '../../lib/utils/dateFormat';
  import { formatTimeChip } from '../../lib/tasks/dueDateFormat';
  import { PRIORITY_COLOR, PRIORITY_LABEL } from '../../constants/taskPriorities';
  import { clockStore } from '../../stores/clock.svelte';

  let {
    accentColor,
    onSubmit,
    placeholder = 'Add a task — try "Submit report tomorrow !!high #work"',
    autoFocus = false,
    inputRef = $bindable(),
  }: {
    accentColor: string;
    onSubmit: (parsed: QuickAddParsed) => void;
    placeholder?: string;
    autoFocus?: boolean;
    inputRef?: HTMLInputElement | null;
  } = $props();

  let value = $state('');
  let helpOpen = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();

  // Mirror the local ref to the bindable prop so the parent can call
  // `quickAddInputRef.focus()` from a shortcut handler.
  $effect(() => {
    inputRef = inputEl ?? null;
  });

  // `5/12` follows the OS regional date order (day/month for en-GB).
  const dayFirst = localeIsDayFirst(window.filo?.systemLocale || navigator.language);

  // Live parse of the current input. Recomputed every keystroke; cheap. The
  // clock store's day, so a list left open past midnight reads "tomorrow" right.
  let parsed = $derived(parseQuickAdd(value, { dayFirst, now: clockStore.todayDate() }));

  let hasMeta = $derived(
    !!parsed.dueDate
      || !!parsed.dueTime
      || !!parsed.startDate
      || !!parsed.priority
      || !!parsed.status
      || !!parsed.recurrence
      || parsed.tags.length > 0,
  );

  function submit() {
    if (!parsed.title.trim()) return;
    onSubmit(parsed);
    value = '';
    // Refocus so the user can keep typing rapidly.
    queueMicrotask(() => inputEl?.focus());
  }

  function onKeydown(e: KeyboardEvent) {
    // While an IME composition is active, Enter commits the candidate
    // word, not the task. Don't submit (or clear on Escape) mid-composition.
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      value = '';
      (e.currentTarget as HTMLInputElement).blur();
    }
  }

  // The chips show a date and a priority as the task's row will.
  function fmtDateChip(iso: string): string {
    return formatDay(iso, { now: clockStore.todayDate() });
  }

  $effect(() => {
    if (autoFocus && inputEl) inputEl.focus();
  });
</script>

<div class="quick-add" style:--accent={accentColor}>
  <div class="quick-add-row">
    <button
      class="quick-add-submit"
      onclick={submit}
      disabled={!parsed.title.trim()}
      title="Add task (Enter)"
      aria-label="Add task"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
    <input
      bind:this={inputEl}
      bind:value
      type="text"
      class="quick-add-input"
      {placeholder}
      onkeydown={onKeydown}
      aria-label="Quick add task"
    />
    <button
      class="quick-add-help"
      class:active={helpOpen}
      onclick={() => (helpOpen = !helpOpen)}
      title="Show token help"
      aria-label="Show token syntax help"
      aria-expanded={helpOpen}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </button>
  </div>

  {#if hasMeta}
    <div class="quick-add-preview">
      {#if parsed.priority}
        <span class="chip chip-priority" style:color={PRIORITY_COLOR[parsed.priority]}>
          {PRIORITY_LABEL[parsed.priority]}
        </span>
      {/if}
      {#if parsed.dueDate}
        <span class="chip chip-date">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span>{fmtDateChip(parsed.dueDate)}{parsed.dueTime ? ` ${formatTimeChip(parsed.dueTime)}` : ''}</span>
        </span>
      {/if}
      {#if !parsed.dueDate && parsed.dueTime}
        <span class="chip chip-date">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>{formatTimeChip(parsed.dueTime)}</span>
        </span>
      {/if}
      {#if parsed.startDate}
        <span class="chip chip-start">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>
          <span>Start {fmtDateChip(parsed.startDate)}</span>
        </span>
      {/if}
      {#if parsed.recurrence}
        <span class="chip chip-repeat">Repeats {recurrenceLabel(parsed.recurrence).toLowerCase()}</span>
      {/if}
      {#if parsed.status}
        <span class="chip chip-status">= {parsed.status}</span>
      {/if}
      {#each parsed.tags as tag (tag)}
        <span class="chip chip-tag">#{tag}</span>
      {/each}
    </div>
  {/if}

  {#if helpOpen}
    <div class="quick-add-help-panel" role="region" aria-label="Quick-add token syntax">
      <div class="help-grid">
        <code>today</code><span>set due to today</span>
        <code>tomorrow</code><span>set due to tomorrow</span>
        <code>next mon</code><span>next Monday (any weekday's name or short name)</span>
        <code>in 3d</code><span>3 days from today (d/w/m)</span>
        <code>2026-05-20</code><span>explicit ISO date</span>
        <code>5/12</code><span>{dayFirst ? 'day/month' : 'month/day'} as the last word (rolls forward if past)</span>
        <code>tomorrow 5pm</code><span>a time after the date</span>
        <code>every fri</code><span>repeat weekly (also every 2 weeks, every other day, every month, every weekday)</span>
        <code>^next mon</code><span>start (defer) date — caret prefix</span>
        <code>@5pm</code><span>time-of-day (24h or am/pm)</span>
        <code>!high</code><span>priority (low/med/high/urgent)</span>
        <code>!!</code><span>shorthand for urgent (use !high to name a level)</span>
        <code>#tag</code><span>add a tag (multiple allowed)</span>
        <code>=in-progress</code><span>set status</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .quick-add {
    --accent: var(--accent-primary);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px;
    background: var(--ui-surface);
    border-bottom: 1px solid var(--ui-border-light);
    position: sticky;
    top: 0;
    z-index: 3;
  }

  .quick-add-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .quick-add-submit {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: none;
    background: var(--accent);
    color: var(--text-inverse);
    cursor: pointer;
    transition: opacity 0.15s ease, transform 0.1s ease;
  }

  .quick-add-submit:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .quick-add-submit:not(:disabled):hover {
    transform: scale(1.05);
  }

  .quick-add-input {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    color: var(--text-primary);
    background: var(--ui-surface-raised);
    border: 1px solid var(--ui-border-light);
    border-radius: 6px;
    padding: 6px 10px;
    transition: border-color 0.15s ease, background 0.15s ease;
  }

  .quick-add-input:focus {
    border-color: var(--accent);
    background: var(--ui-surface);
  }

  .quick-add-input:focus:not(:focus-visible) {
    outline: none;
  }

  .quick-add-input::placeholder {
    color: var(--text-tertiary);
  }

  .quick-add-help {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .quick-add-help:hover,
  .quick-add-help.active {
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }

  .quick-add-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding-left: 36px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 500;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }

  .chip-priority {
    font-weight: 700;
  }

  .chip-tag {
    color: var(--accent);
  }

  .chip-start {
    color: var(--text-secondary);
    font-style: italic;
  }

  .quick-add-help-panel {
    background: var(--ui-surface-raised);
    border: 1px solid var(--ui-border-light);
    border-radius: 6px;
    padding: 10px 12px;
    margin-left: 36px;
    font-size: 12px;
  }

  .help-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 12px;
    row-gap: 4px;
    color: var(--text-secondary);
  }

  .help-grid code {
    font-family: var(--ui-font-mono, ui-monospace, "SF Mono", monospace);
    color: var(--text-primary);
    background: var(--ui-surface-hover);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
    white-space: nowrap;
  }
</style>
