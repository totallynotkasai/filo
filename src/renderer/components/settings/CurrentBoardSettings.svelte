<script lang="ts">
  /**
   * CurrentBoardSettings — edits the active board's settings, including
   * per-board overrides of the style cascade (`settings.defaults.*`).
   *
   * This component is a thin shell: it renders the empty-state, the
   * board header, the shared "Board" sub-section, and routes to one of
   * the per-type child components for the type-specific overrides.
   *
   * The styles defined here use `:global(...)` so they apply to the
   * shared classnames inside the child components (`.setting-row`,
   * `.setting-label`, etc.).
   */
  import { pendingSettingsStore, settingsBoard } from '../../stores/pendingSettings.svelte';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { BACKGROUND_PATTERN_OPTIONS } from '../../constants/styleOptions';
  import {
    readPath,
    updatePath as update,
  } from '../../lib/settings/currentBoardHelpers';
  import CurrentBoardMindMap from './CurrentBoardMindMap.svelte';
  import CurrentBoardKanban from './CurrentBoardKanban.svelte';
  import CurrentBoardTaskList from './CurrentBoardTaskList.svelte';

  let board = $derived(settingsBoard());
  let settings = $derived(pendingSettingsStore.effectiveBoardSettings);
  const read = (path: string): unknown => readPath(settings, path);

  let boardType = $derived(board?.type ?? null);
</script>

{#if !board}
  <div class="empty-state">
    <p>Open a board to edit its per-board settings.</p>
  </div>
{:else}
  <div class="current-board-settings">
    <header class="board-header">
      <span class="board-chip">{board.type}</span>
      <h3 class="board-title">{board.name}</h3>
    </header>

    <p class="cascade-hint">
      A blank field follows the Global Defaults, and changes with them. A field
      set here is this board's own and overrides the Global Defaults.
    </p>

    <h4 class="subsection-title">Board</h4>
    <div class="setting-row">
      <span class="setting-label">Background Color</span>
      <ColorPicker
        value={(read('backgroundColor') as string) ?? ''}
        onchange={(c) => update('backgroundColor', c)}
      />
    </div>
    <div class="setting-row">
      <label class="setting-label" for="cb-pattern">Background Pattern</label>
      <select
        id="cb-pattern"
        class="setting-select"
        value={(read('backgroundPattern') as string) ?? ''}
        onchange={(e) => update('backgroundPattern', (e.target as HTMLSelectElement).value || undefined)}
      >
        <option value="">— Inherit —</option>
        {#each BACKGROUND_PATTERN_OPTIONS as p (p)}
          <option value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
        {/each}
      </select>
    </div>

    {#if boardType === 'mindmap'}
      <CurrentBoardMindMap />
    {:else if boardType === 'kanban'}
      <CurrentBoardKanban />
    {:else if boardType === 'tasklist'}
      <CurrentBoardTaskList />
    {/if}
  </div>
{/if}

<style>
  .empty-state {
    padding: 24px;
    text-align: center;
    color: var(--text-tertiary);
    font-size: var(--font-size-base);
  }

  .current-board-settings {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .board-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--ui-border);
    margin-bottom: 8px;
  }

  .board-chip {
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--accent-primary-alpha);
    color: var(--accent-primary);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .board-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .cascade-hint {
    font-size: 11px;
    color: var(--text-tertiary);
    margin: 0 0 8px;
    padding: 6px 10px;
    border-left: 3px solid var(--accent-primary-alpha);
    background: var(--ui-bg-secondary);
    border-radius: 3px;
    line-height: 1.5;
  }

  /* The .setting-* + .number-input + .bg-image-* selectors are used by
   * the per-type child components too. Mark them :global so Svelte's
   * scoped-style hashing doesn't strip them from child DOM. */
  :global(.current-board-settings .subsection-title) {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent-primary);
    margin: 12px 0 4px;
  }

  :global(.current-board-settings .setting-row) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
    gap: 12px;
  }

  :global(.current-board-settings .setting-label) {
    font-size: var(--font-size-base);
    color: var(--text-secondary);
  }

  :global(.current-board-settings .setting-select) {
    min-width: 140px;
    padding: 5px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: 12px;
    font-family: var(--font-system);
  }

  :global(.current-board-settings .setting-select:focus) {
    border-color: var(--ui-border-focus);
  }
  :global(.current-board-settings .setting-select:focus:not(:focus-visible)) {
    outline: none;
  }

  :global(.current-board-settings .setting-input) {
    padding: 5px 8px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: 12px;
    font-family: var(--font-system);
  }

  :global(.current-board-settings .setting-input:focus) {
    border-color: var(--ui-border-focus);
  }
  :global(.current-board-settings .setting-input:focus:not(:focus-visible)) {
    outline: none;
  }

  :global(.current-board-settings .number-input) {
    width: 90px;
    text-align: center;
  }

  :global(.current-board-settings .bg-image-row) {
    align-items: center;
  }

  :global(.current-board-settings .bg-image-controls) {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  :global(.current-board-settings .bg-image-thumb) {
    width: 28px;
    height: 28px;
    border-radius: 4px;
    border: 1px solid var(--ui-border);
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
  }

  :global(.current-board-settings .bg-image-btn) {
    padding: 4px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: 11px;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }

  :global(.current-board-settings .bg-image-btn:hover) {
    background: var(--ui-surface-hover);
    border-color: var(--accent-primary);
  }

  :global(.current-board-settings .bg-image-btn.primary) {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: var(--text-inverse);
  }

  :global(.current-board-settings .bg-image-btn.primary:hover) {
    background: var(--accent-primary-hover);
  }

  :global(.current-board-settings .bg-image-btn.danger) {
    color: var(--accent-danger);
    border-color: var(--accent-danger);
  }

  :global(.current-board-settings .bg-image-btn.danger:hover) {
    background: var(--menu-danger-bg);
  }
</style>
