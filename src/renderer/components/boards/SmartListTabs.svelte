<script lang="ts">
  /**
   * SmartListTabs — built-in filter tabs that sit above the task list:
   *   All / Today / Upcoming / Overdue / No date / Completed
   *
   * Pure presentational. The parent decides what each tab actually filters on,
   * and passes back the count for each so the user can scan workload at a
   * glance. Selecting a tab fires `onSelect(id)`.
   */

  export type SmartListId =
    | 'all'
    | 'today'
    | 'upcoming'
    | 'overdue'
    | 'no-date'
    | 'completed';

  let {
    active,
    counts,
    accentColor,
    onSelect,
  }: {
    active: SmartListId;
    counts: Record<SmartListId, number>;
    accentColor: string;
    onSelect: (id: SmartListId) => void;
  } = $props();

  interface TabDef {
    id: SmartListId;
    label: string;
    iconPath: string;
  }

  const TABS: TabDef[] = [
    { id: 'all', label: 'All', iconPath: 'M4 6h16M4 12h16M4 18h16' },
    { id: 'today', label: 'Today', iconPath: 'M12 8v4l3 2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z' },
    {
      id: 'upcoming',
      label: 'Upcoming',
      iconPath: 'M17 3v4M7 3v4M3 11h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    },
    {
      id: 'overdue',
      label: 'Overdue',
      iconPath: 'M12 2 2 22h20zM12 9v4M12 17h.01',
    },
    {
      id: 'no-date',
      label: 'No date',
      iconPath: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM7 3v4M17 3v4',
    },
    {
      id: 'completed',
      label: 'Completed',
      iconPath: 'M20 6 9 17l-5-5',
    },
  ];
</script>

<div class="smart-tabs" style:--accent={accentColor} role="tablist" aria-label="Smart list filters">
  {#each TABS as tab (tab.id)}
    {@const isActive = active === tab.id}
    <button
      class="tab"
      class:active={isActive}
      role="tab"
      aria-selected={isActive}
      onclick={() => onSelect(tab.id)}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
       aria-hidden="true">
        <path d={tab.iconPath} />
      </svg>
      <span class="label">{tab.label}</span>
      {#if counts[tab.id] > 0}
        <span class="count" class:overdue-count={tab.id === 'overdue'}>{counts[tab.id]}</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .smart-tabs {
    --accent: var(--accent-primary);
    display: flex;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    padding: 4px;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border-light);
    border-radius: 8px;
    scrollbar-width: thin;
  }

  .tab {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.15s ease, color 0.15s ease;
  }

  .tab:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .tab.active {
    background: var(--accent);
    color: var(--text-inverse);
  }

  .tab.active .count {
    background: color-mix(in srgb, var(--text-inverse) 22%, transparent);
    color: var(--text-inverse);
  }

  .label {
    line-height: 1;
  }

  .count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 5px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 700;
    background: var(--ui-surface-hover);
    color: var(--text-secondary);
  }

  .tab:not(.active) .overdue-count {
    background: var(--accent-danger, #e5484d);
    color: white;
  }
</style>
