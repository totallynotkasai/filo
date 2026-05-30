<script lang="ts">
  import { vaultStore } from '../../stores/vault.svelte';
  import { themeStore } from '../../stores/theme.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { reportError } from '../../lib/utils/errorBus';
  import { ACCENT_COLOR } from '../../constants/defaults';
  import { listBuiltinThemes, THEME_VAR_NAMES } from '../../lib/themes/themeManager';
  import type { ThemeId } from '../../../shared/types';

  let newThemeName = $state('');

  const builtInIds = listBuiltinThemes();
  const builtInLabels: Record<ThemeId, { label: string; preview: string }> = {
    light: { label: 'Light Mode', preview: '#f8f9fa' },
    dark: { label: 'Dark Mode', preview: '#1a1a2e' },
    blueprint: { label: 'Blueprint', preview: '#0a1929' },
    retro: { label: 'Retro', preview: '#2b1b0e' },
    nature: { label: 'Nature', preview: '#0a2a1b' },
  };

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

  async function selectThemeById(id: string) {
    if (!vaultStore.path) return;
    const result = await themeStore.applyById(vaultStore.path, id);
    if (!result.ok) {
      reportError(
        'ThemeManager.applyById',
        result.error ?? `Theme "${id}" could not be applied`,
        `Theme "${id}" could not be applied${result.error ? ` — ${result.error}` : ''}. Reverted to default.`,
      );
      return;
    }
    if ((builtInIds as readonly string[]).includes(id)) {
      // In systemOnly mode the user is explicitly preserving their
      // canvas/tile/connection palette — don't persist the theme as the
      // active one AND don't wipe their color overrides.
      if (!themeStore.systemOnly) {
        vaultStore.setTheme(id as ThemeId);
        resetSettingsColorsToThemeDefaults();
        // Flush the active-theme + color resets to disk immediately.
        // vaultStore.setTheme calls markMetaDirty which only schedules a
        // 300ms-debounced write; without this await, a hard quit inside
        // that window reverts to the previously-persisted theme.
        try {
          await vaultStore.save();
        } catch (err) {
          reportError('ThemeManager.persist', err, 'Failed to save theme selection');
        }
      }
    }
  }

  /**
   * Resets all color properties in project settings to empty strings
   * so CSS custom properties from the active theme take over.
   * Non-color settings (borderWidth, shape, shadowIntensity, etc.) are preserved.
   */
  function resetSettingsColorsToThemeDefaults() {
    if (!vaultStore.project) return;
    const s = vaultStore.project.settings;

    s.mindmap.backgroundColor = '';
    s.mindmap.tile.headerColor = '';
    s.mindmap.tile.bodyColor = '';
    s.mindmap.tile.borderColor = '';
    s.mindmap.connectionPath.pathColor = '';
    s.mindmap.connectionPath.arrowColor = '';
    s.mindmap.connectionLabel.textColor = '';
    s.mindmap.connectionLabel.backgroundColor = '';
    s.mindmap.frame.headerColor = '';
    s.mindmap.frame.bodyColor = '';
    s.mindmap.frame.borderColor = '';

    s.kanban.backgroundColor = '';
    s.kanban.accentColor = '';
    s.kanban.column.headerColor = '';
    s.kanban.column.bodyColor = '';
    s.kanban.column.borderColor = '';
    s.kanban.card.backgroundColor = '';
    s.kanban.card.borderColor = '';

    s.tasklist.backgroundColor = '';
    s.tasklist.accentColor = '';
    s.tasklist.task.bodyColor = '';
    s.tasklist.section.headerColor = '';
    s.tasklist.section.bodyColor = '';
    s.tasklist.section.borderColor = '';

    s.document.backgroundColor = '';
    s.document.accentColor = '';
    s.document.document.bodyColor = '';
    s.document.document.borderColor = '';

    vaultStore.markMetaDirty();
  }

  /**
   * Captures the current theme variables from `:root` so the snapshot
   * stays faithful to whatever the user is actually seeing — including
   * any custom theme overrides that are currently active.
   *
   * Sources the variable name list from `THEME_VAR_NAMES` so adding a
   * new themeable variable in one place (themeManager.ts) automatically
   * extends what "Save current as theme" captures.
   */
  function snapshotCurrentVariables(): Record<string, string> {
    const root = document.documentElement;
    const computed = getComputedStyle(root);
    const out: Record<string, string> = {};
    for (const key of THEME_VAR_NAMES) {
      const v = computed.getPropertyValue(key).trim();
      if (v) out[key] = v;
    }
    return out;
  }

  async function saveCurrentAsTheme() {
    const name = newThemeName.trim();
    if (!name || !vaultStore.path) return;
    const variables = snapshotCurrentVariables();
    const id = await themeStore.saveCurrentAsTheme(
      vaultStore.path,
      name,
      variables,
      themeStore.active,
    );
    if (id) {
      newThemeName = '';
      uiStore.toast(`Theme "${name}" saved`, 'success');
    } else {
      uiStore.toast('Failed to save theme', 'error');
    }
  }

  async function deleteCustomTheme(id: string) {
    if (!vaultStore.path) return;
    const file = themeStore.cache[id];
    const ok = await themeStore.deleteTheme(vaultStore.path, id);
    if (ok) {
      uiStore.toast(`Deleted theme "${file?.name ?? id}"`, 'info');
    } else {
      uiStore.toast(`Failed to delete theme "${file?.name ?? id}"`, 'error');
    }
  }
</script>

<div class="theme-manager">
  <h3 class="section-title">Themes</h3>

  <!-- System-Only toggle. When ON, picking a theme rewrites only the
       toolbar/sidebar/menus/modals/etc. and leaves canvas, tile, frame,
       and connection colours on whatever the user has set. Session-only —
       not persisted in vault settings. -->
  <div class="system-only-row">
    <div class="system-only-text">
      <span class="setting-label">Apply System Colours Only</span>
      <span class="system-only-hint">Re-skins chrome (toolbar, sidebar, menus, modals, tab bar) without touching canvas, tile, frame, or connection colours.</span>
    </div>
    <button
      class="toggle-btn"
      class:active={themeStore.systemOnly}
      onclick={() => themeStore.setSystemOnly(!themeStore.systemOnly)}
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
      {@const theme = builtInLabels[themeId]}
      <button
        class="theme-card"
        class:active={activeFileId === themeId}
        onclick={() => selectThemeById(themeId)}
        aria-label="Select {theme.label} theme"
      >
        <div class="theme-preview" style="background: {theme.preview};">
          <div class="preview-bar" style="background: {theme.preview === '#f8f9fa' ? '#e0e0e0' : 'rgba(255,255,255,0.1)'}"></div>
          <div class="preview-content">
            <div class="preview-dot" style="background: {ACCENT_COLOR}"></div>
            <div class="preview-line" style="background: {theme.preview === '#f8f9fa' ? '#ccc' : 'rgba(255,255,255,0.2)'}"></div>
          </div>
        </div>
        <span class="theme-name">{theme.label}</span>
        {#if activeFileId === themeId}
          <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" stroke-width="3" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        {/if}
      </button>
    {/each}
  </div>

  <!-- Custom Themes -->
  <h4 class="subsection-title">Custom Themes</h4>
  {#if customThemeIds.length === 0}
    <p class="empty-text">No custom themes yet. Save your current settings as a theme below.</p>
  {:else}
    <div class="custom-theme-list">
      {#each customThemeIds as id (id)}
        {@const theme = themeStore.cache[id]}
        <div class="custom-theme-item">
          <button
            class="custom-theme-btn"
            class:active={activeFileId === id}
            onclick={() => selectThemeById(id)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>
            </svg>
            {theme?.name ?? id}
          </button>
          <button
            class="delete-btn"
            onclick={() => deleteCustomTheme(id)}
            title="Delete theme"
            aria-label="Delete {theme?.name ?? id}"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Save Current as Theme -->
  <div class="setting-divider"></div>
  <h4 class="subsection-title">Save Current Settings as Theme</h4>
  <div class="save-theme-row">
    <input
      class="theme-name-input"
      type="text"
      placeholder="Theme name..."
      bind:value={newThemeName}
      onkeydown={(e) => { if (e.key === 'Enter') saveCurrentAsTheme(); }}
    />
    <button
      class="btn-primary"
      onclick={saveCurrentAsTheme}
      disabled={!newThemeName.trim()}
    >
      Save Theme
    </button>
  </div>
</div>

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

  .delete-btn {
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

  .delete-btn:hover {
    background: rgba(239, 83, 80, 0.1);
    color: var(--accent-danger);
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

  .setting-divider {
    height: 1px;
    background: var(--ui-border);
    margin: 4px 0;
  }

  .save-theme-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .theme-name-input {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
  }

  .theme-name-input:focus {
    border-color: var(--ui-border-focus);
  }

  .theme-name-input:focus:not(:focus-visible) {
    outline: none;
  }

  .theme-name-input::placeholder {
    color: var(--text-tertiary);
  }

  .btn-primary {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    background: var(--accent-primary);
    color: var(--text-inverse);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.1s ease;
  }

  .btn-primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
