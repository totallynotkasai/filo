<script lang="ts">
  import { vaultStore } from '../../stores/vault.svelte';
  import { themeStore } from '../../stores/theme.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { listBuiltinThemes } from '../../lib/themes/themeManager';
  import { BUILTIN_THEME_LABELS, type ThemeEditorSession } from '../../lib/themes/themeFiles';
  import {
    deleteCustomTheme,
    duplicateThemeSession,
    editThemeSession,
    importThemeSession,
    newThemeSession,
    selectTheme,
    setSystemColoursOnly,
    themePreview,
  } from '../../lib/themes/themeActions';
  import ThemeEditor from './ThemeEditor.svelte';

  const builtInIds = listBuiltinThemes();

  let editing = $state<ThemeEditorSession | null>(null);
  let importInput = $state<HTMLInputElement | null>(null);

  // Refresh the on-disk theme list whenever this panel is shown.
  $effect(() => {
    if (vaultStore.path) {
      void themeStore.refreshAvailable(vaultStore.path);
    }
  });

  // Custom themes = available IDs minus the five built-ins.
  let customThemeIds = $derived(
    themeStore.available.filter((id) => !(builtInIds as readonly string[]).includes(id)),
  );
  let activeFileId = $derived(themeStore.activeFileId);
  // Each card shows its theme's own colours, read from the theme itself.
  let previews = $derived(
    Object.fromEntries([...builtInIds, ...customThemeIds].map((id) => [id, themePreview(id)])),
  );

  function openEditor(session: ThemeEditorSession | null): void {
    if (session) editing = session;
  }

  async function importFile(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      uiStore.toast(`Couldn't read "${file.name}".`, 'error');
      return;
    }
    const session = importThemeSession(text);
    if ('error' in session) {
      uiStore.toast(session.error, 'error');
      return;
    }
    editing = session;
  }
</script>

{#if editing}
  <ThemeEditor session={editing} onclose={() => (editing = null)} />
{:else}
<div class="theme-manager">
  <h3 class="section-title">Themes</h3>

  <!-- System-Only toggle. When ON, picking a theme rewrites only the
       toolbar/sidebar/menus/modals/etc. and leaves canvas, tile, frame,
       and connection colours on whatever the user has set. Session-only —
       not persisted in vault settings. -->
  <div class="system-only-row">
    <div class="system-only-text">
      <span class="setting-label">Apply System Colours Only</span>
      <span class="system-only-hint">Re-skins chrome (toolbar, sidebar, menus, dialogs, tab bar) and leaves boards (canvas, tiles, Kanban and Task List surfaces) on their colours. Lasts until the vault closes.</span>
    </div>
    <button
      class="toggle-btn"
      class:active={themeStore.systemOnly}
      onclick={() => setSystemColoursOnly(!themeStore.systemOnly)}
      role="switch"
      aria-checked={themeStore.systemOnly}
      title="Apply themes to system chrome only"
    >
      <span class="toggle-track">
        <span class="toggle-thumb"></span>
      </span>
      <span class="toggle-label">{themeStore.systemOnly ? 'On' : 'Off'}</span>
    </button>
  </div>

  <!-- Built-in Themes -->
  <h4 class="subsection-title">Default Themes</h4>
  <div class="theme-grid">
    {#each builtInIds as themeId (themeId)}
      {@const label = BUILTIN_THEME_LABELS[themeId]}
      {@const preview = previews[themeId]}
      <div class="theme-card-wrap">
        <button
          class="theme-card"
          class:active={activeFileId === themeId}
          onclick={() => selectTheme(themeId)}
          aria-label="Select {label} theme"
          aria-pressed={activeFileId === themeId}
        >
          <div class="theme-preview" style:background={preview?.background}>
            <div class="preview-bar" style:background={preview?.bar}></div>
            <div class="preview-content">
              <div class="preview-dot" style:background={preview?.accent}></div>
              <div class="preview-line" style:background={preview?.text}></div>
            </div>
          </div>
          <span class="theme-name">{label}</span>
          {#if activeFileId === themeId}
            <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="3" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          {/if}
        </button>
        <button
          class="card-action"
          onclick={() => openEditor(duplicateThemeSession(themeId))}
          title="Duplicate as a custom theme"
          aria-label="Duplicate {label}"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
      </div>
    {/each}
  </div>

  <!-- Custom Themes -->
  <h4 class="subsection-title">Custom Themes</h4>
  {#if customThemeIds.length === 0}
    <p class="empty-text">No custom themes yet. New Theme starts from the colours you see now.</p>
  {:else}
    <div class="custom-theme-list">
      {#each customThemeIds as id (id)}
        {@const name = themeStore.cache[id]?.name ?? id}
        {@const preview = previews[id]}
        <div class="custom-theme-item">
          <button
            class="custom-theme-btn"
            class:active={activeFileId === id}
            onclick={() => selectTheme(id)}
            aria-label="Select {name} theme"
            aria-pressed={activeFileId === id}
          >
            {#if preview}
              <span class="custom-preview" style:background={preview.background} aria-hidden="true">
                <span class="custom-preview-bar" style:background={preview.bar}></span>
                <span class="custom-preview-dot" style:background={preview.accent}></span>
              </span>
            {:else}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>
              </svg>
            {/if}
            {name}
          </button>
          <button class="icon-action" onclick={() => openEditor(editThemeSession(id))} title="Edit theme" aria-label="Edit {name}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>
          </button>
          <button class="icon-action" onclick={() => openEditor(duplicateThemeSession(id))} title="Duplicate theme" aria-label="Duplicate {name}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
          <button class="icon-action delete-btn" onclick={() => deleteCustomTheme(id)} title="Delete theme" aria-label="Delete {name}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="theme-actions">
    <button class="btn-primary" onclick={() => openEditor(newThemeSession())}>New Theme</button>
    <button class="btn-secondary" onclick={() => importInput?.click()}>Import Theme…</button>
    <input
      bind:this={importInput}
      hidden
      type="file"
      accept=".json,application/json"
      onchange={importFile}
    />
  </div>
</div>
{/if}

<style>
  .theme-manager {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .system-only-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    background: var(--ui-bg-secondary, var(--ui-surface));
  }

  .system-only-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .setting-label {
    font-size: var(--font-size-base);
    font-weight: 500;
    color: var(--text-primary);
  }

  .system-only-hint {
    font-size: 11px;
    color: var(--text-tertiary);
    line-height: 1.5;
  }

  .toggle-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0;
    color: var(--text-secondary);
    font-family: var(--font-system);
    font-size: var(--font-size-base);
    flex-shrink: 0;
  }

  .toggle-track {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 10px;
    background: var(--ui-border);
    transition: background-color 0.15s ease;
  }

  .toggle-btn.active .toggle-track {
    background: var(--accent-primary);
  }

  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    transition: transform 0.15s ease;
  }

  .toggle-btn.active .toggle-thumb {
    transform: translateX(16px);
  }

  .toggle-label {
    font-size: 12px;
  }

  .section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .subsection-title {
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--accent-primary);
    margin: 4px 0;
  }

  .theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 10px;
  }

  .theme-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px;
    border: 2px solid var(--ui-border);
    border-radius: 8px;
    background: var(--ui-surface);
    cursor: pointer;
    transition: border-color 0.15s ease, transform 0.1s ease;
    position: relative;
  }

  .theme-card:hover {
    border-color: var(--ui-border-focus);
    transform: translateY(-1px);
  }

  .theme-card.active {
    border-color: var(--accent-primary);
  }

  .theme-preview {
    width: 100%;
    height: 52px;
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    box-sizing: border-box;
  }

  .preview-bar {
    height: 8px;
    width: 100%;
  }

  .preview-content {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px;
  }

  .preview-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .preview-line {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    opacity: 0.6;
  }

  .custom-preview {
    position: relative;
    display: inline-block;
    width: 22px;
    height: 16px;
    border-radius: 3px;
    border: 1px solid var(--ui-border);
    overflow: hidden;
    flex-shrink: 0;
  }

  .custom-preview-bar {
    position: absolute;
    inset: 0 0 auto;
    height: 4px;
  }

  .custom-preview-dot {
    position: absolute;
    left: 4px;
    bottom: 3px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  .theme-name {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .check-icon {
    position: absolute;
    top: 6px;
    right: 6px;
  }

  .custom-theme-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .custom-theme-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .custom-theme-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    padding: 8px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-surface);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    text-align: left;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .custom-theme-btn:hover {
    background: var(--ui-surface-hover);
  }

  .custom-theme-btn.active {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .icon-action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: color 0.1s ease, background-color 0.1s ease;
  }

  .icon-action:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .delete-btn:hover {
    background: var(--menu-danger-bg);
    color: var(--accent-danger);
  }

  .theme-card-wrap {
    position: relative;
    display: flex;
  }

  .theme-card-wrap .theme-card {
    flex: 1;
  }

  .card-action {
    position: absolute;
    top: 4px;
    left: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    background: var(--ui-surface);
    color: var(--text-secondary);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s ease;
  }

  .theme-card-wrap:hover .card-action,
  .card-action:focus-visible {
    opacity: 1;
  }

  .card-action:hover {
    color: var(--text-primary);
  }

  .empty-text {
    font-size: 12px;
    color: var(--text-tertiary);
    margin: 0;
    padding: 8px;
    text-align: center;
    border: 1px dashed var(--ui-border);
    border-radius: 6px;
  }

  .theme-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    padding-top: 4px;
  }

  .btn-primary,
  .btn-secondary {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.1s ease, background-color 0.1s ease;
  }

  .btn-primary {
    border: none;
    background: var(--accent-primary);
    color: var(--text-inverse);
  }

  .btn-primary:hover {
    opacity: 0.9;
  }

  .btn-secondary {
    border: 1px solid var(--ui-border);
    background: var(--ui-surface);
    color: var(--text-primary);
  }

  .btn-secondary:hover {
    background: var(--ui-surface-hover);
  }

  @media (prefers-reduced-motion: reduce) {
    .card-action,
    .icon-action,
    .btn-primary,
    .btn-secondary {
      transition: none;
    }
  }
</style>
