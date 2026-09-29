<script lang="ts">
  /**
   * TaskBulkActionBar — floating bar that appears when ≥1 task row is
   * selected. Hosts the bulk verbs (Set Priority / Set Due / Set Tags /
   * Mark Complete / Delete / Clear). Pure presentational — the parent
   * (`TaskListBoard`) wires each callback to the matching mutation.
   */

  import { localIsoDateInDays } from '../../lib/utils/dateFormat';

  type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

  let {
    count,
    onClear,
    onSetPriority,
    onMarkComplete,
    onMarkIncomplete,
    onSetDueDate,
    onDelete,
    availableSections = [],
    onMoveToSection,
  }: {
    count: number;
    onClear: () => void;
    onSetPriority: (p: Priority) => void;
    onMarkComplete: () => void;
    onMarkIncomplete: () => void;
    onSetDueDate: (iso: string) => void;
    onDelete: () => void;
    /** Every section that exists on the host board, in sort order. The
     *  "Move to section…" flyout is hidden when this list has fewer than
     *  two entries (no destination distinct from "the only section"). */
    availableSections?: Array<{ id: string; title: string }>;
    /** Bulk move handler — fires for each section the user picks. The host
     *  is responsible for resolving the synthetic default-section id (the
     *  bulk bar receives the resolved ids only). */
    onMoveToSection?: (sectionId: string) => void;
  } = $props();

  let priorityMenuOpen = $state(false);
  let dueMenuOpen = $state(false);
  let sectionMenuOpen = $state(false);

  function closeAll() {
    priorityMenuOpen = false;
    dueMenuOpen = false;
    sectionMenuOpen = false;
  }

  const PRIORITIES: Array<{ id: Priority; label: string; color: string }> = [
    { id: 'urgent', label: 'Urgent', color: 'var(--priority-urgent)' },
    { id: 'high', label: 'High', color: 'var(--priority-high)' },
    { id: 'medium', label: 'Medium', color: 'var(--priority-medium)' },
    { id: 'low', label: 'Low', color: 'var(--priority-low)' },
    { id: 'none', label: 'None', color: 'var(--text-tertiary)' },
  ];
</script>

<div class="bulk-bar" role="toolbar" aria-label="Bulk task actions">
  <span class="count" aria-live="polite">
    {count} selected
  </span>

  <div class="bar-group">
    <button
      class="bar-btn"
      onclick={() => { const o = !priorityMenuOpen; closeAll(); priorityMenuOpen = o; }}
      aria-haspopup="menu"
      aria-expanded={priorityMenuOpen}
    >
      Set Priority
    </button>
    {#if priorityMenuOpen}
      <div class="bar-menu" role="menu">
        {#each PRIORITIES as p (p.id)}
          <button
            class="bar-menu-item"
            onclick={() => { priorityMenuOpen = false; onSetPriority(p.id); }}
            style:color={p.color}
          >
            {p.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="bar-group">
    <button
      class="bar-btn"
      onclick={() => { const o = !dueMenuOpen; closeAll(); dueMenuOpen = o; }}
      aria-haspopup="menu"
      aria-expanded={dueMenuOpen}
    >
      Set Due
    </button>
    {#if dueMenuOpen}
      <div class="bar-menu" role="menu">
        <button class="bar-menu-item" onclick={() => { dueMenuOpen = false; onSetDueDate(localIsoDateInDays(0)); }}>Today</button>
        <button class="bar-menu-item" onclick={() => { dueMenuOpen = false; onSetDueDate(localIsoDateInDays(1)); }}>Tomorrow</button>
        <button class="bar-menu-item" onclick={() => { dueMenuOpen = false; onSetDueDate(localIsoDateInDays(7)); }}>Next week</button>
        <button class="bar-menu-item danger" onclick={() => { dueMenuOpen = false; onSetDueDate(''); }}>Clear due date</button>
      </div>
    {/if}
  </div>

  {#if onMoveToSection && availableSections.length > 1}
    <div class="bar-group">
      <button
        class="bar-btn"
        onclick={() => { const o = !sectionMenuOpen; closeAll(); sectionMenuOpen = o; }}
        aria-haspopup="menu"
        aria-expanded={sectionMenuOpen}
      >
        Move to Section…
      </button>
      {#if sectionMenuOpen}
        <div class="bar-menu" role="menu">
          {#each availableSections as section (section.id)}
            <button
              class="bar-menu-item"
              onclick={() => { sectionMenuOpen = false; onMoveToSection?.(section.id); }}
            >
              {section.title}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <button class="bar-btn" onclick={onMarkComplete}>Mark Complete</button>
  <button class="bar-btn" onclick={onMarkIncomplete}>Mark Incomplete</button>
  <button class="bar-btn danger" onclick={onDelete}>Delete</button>

  <button class="bar-btn ghost" onclick={onClear} aria-label="Clear selection">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  </button>
</div>

<style>
  .bulk-bar {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    background: var(--menu-bg);
    border: 1px solid var(--menu-border);
    border-radius: 10px;
    box-shadow: var(--ui-shadow-lg);
    z-index: 40;
    animation: rise 0.18s ease;
  }

  .count {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    padding: 0 8px 0 4px;
    border-right: 1px solid var(--ui-border-light);
    margin-right: 4px;
  }

  .bar-group {
    position: relative;
  }

  .bar-btn {
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .bar-btn:hover {
    background: var(--ui-surface-hover);
  }

  .bar-btn.danger {
    color: var(--accent-danger);
  }

  .bar-btn.danger:hover {
    background: var(--menu-danger-bg, rgba(255, 107, 107, 0.1));
  }

  .bar-btn.ghost {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    padding: 6px;
    color: var(--text-tertiary);
  }

  .bar-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    min-width: 140px;
    padding: 4px;
    background: var(--menu-bg);
    border: 1px solid var(--menu-border);
    border-radius: 6px;
    box-shadow: var(--ui-shadow-lg);
    z-index: 41;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .bar-menu-item {
    text-align: left;
    padding: 6px 10px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }

  .bar-menu-item:hover {
    background: var(--menu-hover);
  }

  .bar-menu-item.danger {
    color: var(--accent-danger);
  }

  @keyframes rise {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
</style>
