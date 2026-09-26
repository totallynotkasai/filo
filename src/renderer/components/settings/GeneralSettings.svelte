<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { vaultStore } from '../../stores/vault.svelte';
  import { uiStore } from '../../stores/ui.svelte';
  import { reportError } from '../../lib/utils/errorBus';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { applyFontDefaultsToAllExisting as applyFontDefaultsToAllExistingLib } from '../../lib/styles/applyDefaultsToAll';
  import { defaultProjectSettings, GeneralSettingsSchema } from '../../schema/index';
  import { numberBoundsAt, readNumberField } from '../../lib/settings/numberInput';
  import { LINE_SPACING_CHOICES, formatLineSpacing } from '../../stores/noteMeta';
  import { fontFromStack, fontStack } from '../../../shared/fontStack';
  import { GENERAL_SETTINGS_DEFAULTS } from '../../../shared/generalSettingsDefaults';
  import { registerImportedFonts } from '../../lib/fonts/importedFonts';

  // Local state derived from project settings
  let settings = $derived(vaultStore.project?.settings?.general ?? defaultProjectSettings().general);

  type HoverButtonKey =
    | 'tiles'
    | 'cards'
    | 'tasks'
    | 'frames'
    | 'connectionLabels'
    | 'columns';

  const hoverButtonControls: { key: HoverButtonKey; label: string }[] = [
    { key: 'tiles', label: 'Tiles' },
    { key: 'cards', label: 'Cards' },
    { key: 'tasks', label: 'Tasks' },
    { key: 'frames', label: 'Frames' },
    { key: 'connectionLabels', label: 'Connection Labels' },
    { key: 'columns', label: 'Columns' },
  ];

  function hoverButtonValue(key: HoverButtonKey): boolean {
    return settings.hoverButtons?.[key] ?? true;
  }

  /**
   * Replaces the whole `hoverButtons` object so Svelte's tracker sees a new
   * top-level reference — mirrors the `defaultBoardFontSize` pattern below.
   */
  function toggleHoverButton(key: HoverButtonKey) {
    if (!vaultStore.project) return;
    const current = vaultStore.project.settings.general.hoverButtons ?? {
      tiles: true, cards: true, tasks: true, frames: true,
      connectionLabels: true, columns: true,
    };
    vaultStore.project.settings.general.hoverButtons = {
      ...current,
      [key]: !(current[key] ?? true),
    };
    vaultStore.markMetaDirty();
  }

  let systemFonts = $state<string[]>([]);
  let loadingFonts = $state(false);

  // "Open last vault on launch" — a per-machine preference persisted by the
  // main process in userData (separate from any vault's .filo/ since it must
  // be readable before any vault is open).
  let openOnLaunch = $state(true);

  // Load system fonts on mount
  $effect(() => {
    loadSystemFonts();
  });

  $effect(() => {
    void loadLaunchPreference();
  });

  async function loadLaunchPreference(): Promise<void> {
    try {
      const pref = await window.filo.invoke('vault:get-launch-preference');
      openOnLaunch = pref.openOnLaunch;
    } catch {
      openOnLaunch = true;
    }
  }

  async function toggleOpenOnLaunch(): Promise<void> {
    const next = !openOnLaunch;
    openOnLaunch = next;
    try {
      const result = await window.filo.invoke('vault:set-open-on-launch', next);
      if (!result.success) {
        // Revert on failure so the UI reflects on-disk state.
        openOnLaunch = !next;
        uiStore.toast('Failed to save preference', 'error');
      }
    } catch {
      openOnLaunch = !next;
      uiStore.toast('Failed to save preference', 'error');
    }
  }

  async function loadSystemFonts() {
    loadingFonts = true;
    try {
      const fonts = await window.filo.invoke('font:list-system');
      systemFonts = fonts;
    } catch {
      systemFonts = [...GENERAL_SETTINGS_DEFAULTS.systemFonts];
    }
    loadingFonts = false;
  }

  // Union: OS-enumerated fonts ∪ project-saved (imported) fonts ∪ currently
  // selected family. The third entry guards against a renamed/missing font
  // still being the active value — the dropdown stays consistent with the
  // displayed selection. Without this union the <select> was iterating
  // settings.systemFonts only, so a fresh project with no saved fonts
  // showed an empty list even though OS fonts were loaded.
  let availableFonts = $derived.by(() => {
    const selected = fontFromStack(settings.globalFont ?? '');
    const merged = new SvelteSet<string>();
    for (const f of systemFonts) if (f) merged.add(f);
    for (const f of settings.systemFonts ?? []) if (f) merged.add(f);
    if (selected) merged.add(selected);
    return [...merged].sort((a, b) => a.localeCompare(b));
  });

  function updateSetting<K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) {
    if (!vaultStore.project) return;
    (vaultStore.project.settings.general as Record<string, unknown>)[key] = value;
    vaultStore.markMetaDirty();
  }

  /**
   * Updates a single sub-field of `defaultBoardFontSize`. Replaces the
   * whole object so Svelte's tracker sees a new top-level reference —
   * mutating the existing object in place leaves derived consumers
   * (the App-level $effect that writes the CSS variables) stale.
   */
  type DefaultBoardFontSizeKey =
    | 'tileTitle'
    | 'tileBody'
    | 'connectionLabel'
    | 'frameTitle'
    | 'kanbanColumnTitle'
    | 'kanbanCardTitle'
    | 'kanbanCardBody'
    | 'taskListTitle'
    | 'taskItem'
    | 'taskItemBody'
    | 'taskSectionTitle';

  // Drives the Default Board Font Size group. Each row's range is read from
  // the schema (Connection Label caps at 32, everything else at 48).
  const BOARD_FONT_SIZE_DEFAULTS = defaultProjectSettings().general.defaultBoardFontSize;
  const fontSizeControls: {
    key: DefaultBoardFontSizeKey;
    label: string;
  }[] = [
    { key: 'tileTitle', label: 'Tile Title (px)' },
    { key: 'tileBody', label: 'Tile Body (px)' },
    { key: 'connectionLabel', label: 'Connection Label (px)' },
    { key: 'frameTitle', label: 'Frame Title (px)' },
    { key: 'kanbanColumnTitle', label: 'Kanban Column Title (px)' },
    { key: 'kanbanCardTitle', label: 'Kanban Card Title (px)' },
    { key: 'kanbanCardBody', label: 'Kanban Card Body (px)' },
    { key: 'taskListTitle', label: 'Task List Title (px)' },
    { key: 'taskItem', label: 'Task Title (px)' },
    { key: 'taskItemBody', label: 'Task Body (px)' },
    { key: 'taskSectionTitle', label: 'Task Section Title (px)' },
  ];

  /**
   * Opens a confirmation modal, then walks every existing element across
   * every board and writes the current Default Board Font Size values as
   * per-element overrides. See `applyDefaultsToAll.ts` for the walk.
   */
  function applyFontDefaultsToAllExisting() {
    uiStore.openConfirm({
      title: 'Apply Default Font Sizes to All Existing Items?',
      body:
        'This will override per-element font-size choices on every tile, frame, ' +
        'connection label, Kanban column / card, and Task List task across all ' +
        'boards in this vault. This action is not undoable.',
      confirmLabel: 'Apply',
      danger: true,
      onConfirm: () => {
        const { boardsTouched, elementsTouched } = applyFontDefaultsToAllExistingLib();
        if (elementsTouched === 0) {
          uiStore.toast('No elements to update.', 'info');
        } else {
          uiStore.toast(
            `Applied default font sizes to ${elementsTouched} element${elementsTouched === 1 ? '' : 's'} across ${boardsTouched} board${boardsTouched === 1 ? '' : 's'}.`,
            'success',
          );
        }
      },
    });
  }

  function updateBoardFontSize(key: DefaultBoardFontSizeKey, value: number) {
    if (!vaultStore.project) return;
    const current = vaultStore.project.settings.general.defaultBoardFontSize
      ?? defaultProjectSettings().general.defaultBoardFontSize;
    vaultStore.project.settings.general.defaultBoardFontSize = { ...current, [key]: value };
    vaultStore.markMetaDirty();
  }

  function removeFont(font: string) {
    if (!vaultStore.project) return;
    const fonts = vaultStore.project.settings.general.systemFonts;
    if (fonts.length <= 1) {
      uiStore.toast('Must keep at least one font', 'warning');
      return;
    }
    vaultStore.project.settings.general.systemFonts = fonts.filter(f => f !== font);
    vaultStore.markMetaDirty();
  }

  async function importFont() {
    try {
      const vaultPath = vaultStore.path || undefined;
      const result = await window.filo.invoke('font:import', vaultPath);

      if (!result.success || result.fonts.length === 0) return;

      const loaded = await registerImportedFonts(result.fonts);
      if (loaded.length === 0 || !vaultStore.project) return;
      // Only fonts that loaded are listed, so the pickers never offer one that can't render.
      const names = vaultStore.project.settings.general.systemFonts;
      const added = loaded.map((font) => font.name).filter((name) => !names.includes(name));
      if (added.length > 0) vaultStore.project.settings.general.systemFonts = [...names, ...added];
      vaultStore.markMetaDirty();
      uiStore.toast(`Imported ${loaded.length} font(s)`, 'success');
    } catch (err) {
      reportError('GeneralSettings.font-import', err, 'Font import failed');
    }
  }

  // ── Per-surface UI scale sliders (Feature 1) ──
  //
  // The on-screen control reads a percentage (50–200); we divide by 100
  // before writing the scale factor (0.5–2.0) back to settings.
  type ScaleKey =
    | 'globalToolbarScale'
    | 'boardToolbarScale'
    | 'tabBarScale'
    | 'minimapScale'
    | 'waypointScale';

  const scaleControls: { key: ScaleKey; label: string }[] = [
    { key: 'globalToolbarScale', label: 'Global Toolbar Scale' },
    { key: 'boardToolbarScale', label: 'Board Toolbar Scale' },
    { key: 'tabBarScale', label: 'Tab Bar Scale' },
    { key: 'minimapScale', label: 'Minimap Scale' },
    { key: 'waypointScale', label: 'Waypoint Marker Scale' },
  ];

  function scalePercent(key: ScaleKey): number {
    const raw = (settings as Record<string, unknown>)[key];
    const scale = typeof raw === 'number' && raw > 0 ? raw : 1;
    return Math.round(scale * 100);
  }

  function setScalePercent(key: ScaleKey, percent: number) {
    const clamped = Math.max(50, Math.min(200, percent));
    updateSetting(key as keyof typeof settings, (clamped / 100) as (typeof settings)[keyof typeof settings]);
  }
</script>

<div class="general-settings">
  <h3 class="section-title">General Settings</h3>
  <p class="auto-save-hint">Changes here save automatically.</p>

  <!-- Launch behaviour -->
  <div class="setting-row">
    <div class="setting-label-stack">
      <span class="setting-label">Open last vault on launch</span>
      <span class="setting-hint">When enabled, Filo opens the most recently used vault at startup. Disable to always show the Home screen.</span>
    </div>
    <button
      class="toggle-btn"
      class:active={openOnLaunch}
      onclick={toggleOpenOnLaunch}
      role="switch"
      aria-checked={openOnLaunch}
      aria-label="Open last vault on launch"
    >
      <span class="toggle-track">
        <span class="toggle-thumb"></span>
      </span>
      <span class="toggle-label">{openOnLaunch ? 'On' : 'Off'}</span>
    </button>
  </div>

  <div class="setting-divider"></div>

  <!-- Global Font -->
  <div class="setting-row">
    <label class="setting-label" for="global-font">Global Font {loadingFonts ? '(loading…)' : ''}</label>
    <select
      id="global-font"
      class="setting-select"
      value={fontFromStack(settings.globalFont)}
      onchange={(e) => {
        const font = (e.target as HTMLSelectElement).value;
        updateSetting('globalFont', fontStack(font));
      }}
    >
      {#each availableFonts as font (font)}
        <option value={font} style="font-family: {font}">{font}</option>
      {/each}
    </select>
  </div>

  <!-- Default line spacing: every note without its own `lineSpacing:`. -->
  <div class="setting-row">
    <label class="setting-label" for="default-line-spacing">Default line spacing</label>
    <select
      id="default-line-spacing"
      class="setting-select"
      value={String(settings.defaultLineSpacing)}
      onchange={(e) => updateSetting('defaultLineSpacing', Number((e.target as HTMLSelectElement).value))}
    >
      {#if !LINE_SPACING_CHOICES.includes(settings.defaultLineSpacing)}
        <option value={String(settings.defaultLineSpacing)}>{formatLineSpacing(settings.defaultLineSpacing)}</option>
      {/if}
      {#each LINE_SPACING_CHOICES as spacing (spacing)}
        <option value={String(spacing)}>{formatLineSpacing(spacing)}</option>
      {/each}
    </select>
  </div>

  <!-- Global Font Size — affects all system text (toolbar, sidebar, modals). -->
  <div class="setting-row">
    <label class="setting-label" for="global-font-size">Global Font Size (px)</label>
    <input
      id="global-font-size"
      class="setting-input number-input"
      type="number"
      min="10"
      max="20"
      value={settings.globalFontSize}
      onchange={(e) => {
        const val = readNumberField(e.currentTarget, numberBoundsAt(GeneralSettingsSchema, 'globalFontSize'), settings.globalFontSize, false);
        if (val !== undefined) updateSetting('globalFontSize', val);
      }}
    />
  </div>

  <!-- System Fonts -->
  <div class="setting-group">
    <div class="setting-label">System Fonts</div>
    <div class="font-list">
      {#each settings.systemFonts as font (font)}
        <div class="font-chip">
          <span style="font-family: {font}">{font}</span>
          <button
            class="chip-remove"
            onclick={() => removeFont(font)}
            title="Remove font"
            aria-label="Remove {font}"
            disabled={settings.systemFonts.length <= 1}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      {/each}
    </div>
    <button class="btn-secondary" onclick={importFont}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      Import Custom Font
    </button>
  </div>

  <div class="setting-divider"></div>

  <!-- Default Board Font Size — drives the default font-size for newly
       created tiles, frames, and connection labels. Per-element overrides
       still win through the existing style cascade. -->
  <div class="setting-group">
    <div class="setting-label">Default Board Font Size</div>
    {#each fontSizeControls as ctl (ctl.key)}
      <div class="setting-row">
        <label class="setting-label sublabel" for={`bfs-${ctl.key}`}>{ctl.label}</label>
        <input
          id={`bfs-${ctl.key}`}
          class="setting-input number-input"
          type="number"
          min="8"
          max={numberBoundsAt(GeneralSettingsSchema, `defaultBoardFontSize.${ctl.key}`).max}
          value={settings.defaultBoardFontSize?.[ctl.key] ?? BOARD_FONT_SIZE_DEFAULTS[ctl.key]}
          onchange={(e) => {
            const val = readNumberField(
              e.currentTarget,
              numberBoundsAt(GeneralSettingsSchema, `defaultBoardFontSize.${ctl.key}`),
              settings.defaultBoardFontSize?.[ctl.key] ?? BOARD_FONT_SIZE_DEFAULTS[ctl.key],
              false,
            );
            if (val !== undefined) updateBoardFontSize(ctl.key, val);
          }}
        />
      </div>
    {/each}
    <div class="setting-row apply-defaults-row">
      <p class="setting-helper">
        Changing a value above only affects newly-created elements. To rewrite the font-size
        of every existing tile, frame, connection label, column, card, and task in this
        vault, click below.
      </p>
      <button class="btn-secondary apply-defaults-btn" type="button" onclick={applyFontDefaultsToAllExisting}>
        Apply Font Sizes to all Existing Items
      </button>
    </div>
  </div>

  <div class="setting-divider"></div>

  <!-- UI Scale Sliders — replaces the legacy Toolbar/Tab Bar Size enums.
       One slider per surface; 50–200% in 5% steps. -->
  <div class="setting-group">
    <div class="setting-label">UI Scale</div>
    {#each scaleControls as ctl (ctl.key)}
      <div class="setting-row scale-row">
        <label class="setting-label sublabel" for={`scale-${ctl.key}`}>{ctl.label}</label>
        <div class="scale-control">
          <input
            id={`scale-${ctl.key}`}
            class="scale-slider"
            type="range"
            min="50"
            max="200"
            step="5"
            value={scalePercent(ctl.key)}
            oninput={(e) => setScalePercent(ctl.key, parseInt((e.target as HTMLInputElement).value, 10))}
          />
          <span class="scale-badge">{scalePercent(ctl.key)}%</span>
        </div>
      </div>
    {/each}
  </div>

  <!-- Toolbar Color -->
  <div class="setting-row">
    <span class="setting-label">Toolbar Color</span>
    <ColorPicker
      value={settings.toolbarColor}
      onchange={(c) => updateSetting('toolbarColor', c)}
    />
  </div>

  <!-- Tab Bar Color -->
  <div class="setting-row">
    <span class="setting-label">Tab Bar Color</span>
    <ColorPicker
      value={settings.tabBarColor}
      onchange={(c) => updateSetting('tabBarColor', c)}
    />
  </div>

  <div class="setting-divider"></div>

  <!-- Radar Toggle -->
  <div class="setting-row">
    <label class="setting-label" for="radar-toggle">Minimap Radar</label>
    <button
      id="radar-toggle"
      class="toggle-btn"
      class:active={settings.radarEnabled}
      onclick={() => updateSetting('radarEnabled', !settings.radarEnabled)}
      role="switch"
      aria-checked={settings.radarEnabled}
    >
      <span class="toggle-track">
        <span class="toggle-thumb"></span>
      </span>
      <span class="toggle-label">{settings.radarEnabled ? 'On' : 'Off'}</span>
    </button>
  </div>

  <!-- File Extensions Toggle -->
  <div class="setting-row">
    <label class="setting-label" for="file-ext-toggle">Show file extensions in vault</label>
    <button
      id="file-ext-toggle"
      class="toggle-btn"
      class:active={settings.showFileExtensions}
      onclick={() => updateSetting('showFileExtensions', !settings.showFileExtensions)}
      role="switch"
      aria-checked={settings.showFileExtensions}
    >
      <span class="toggle-track">
        <span class="toggle-thumb"></span>
      </span>
      <span class="toggle-label">{settings.showFileExtensions ? 'On' : 'Off'}</span>
    </button>
  </div>

  <div class="setting-divider"></div>

  <!-- Undo History Limit — per-board cap on the undo/redo stack. Lowering
       this truncates existing stacks immediately. -->
  <div class="setting-row">
    <div class="setting-label-stack">
      <span class="setting-label">Undo History Limit</span>
      <span class="setting-hint">Maximum undo steps per board. 10–5000. Raising this lets you step back further; lowering it trims memory used by snapshot-heavy commands.</span>
    </div>
    <input
      id="history-limit"
      class="setting-input number-input"
      type="number"
      min="10"
      max="5000"
      step="10"
      value={settings.historyLimit}
      onchange={(e) => {
        const val = readNumberField(e.currentTarget, numberBoundsAt(GeneralSettingsSchema, 'historyLimit'), settings.historyLimit, false);
        if (val !== undefined) updateSetting('historyLimit', val);
      }}
    />
  </div>

  <div class="setting-divider"></div>

  <!-- Toggle Hover Buttons — per-surface control over whether action buttons
       are revealed on hover/focus (On) or kept permanently visible (Off). -->
  <div class="setting-group">
    <div class="setting-label-stack">
      <span class="setting-label">Toggle Hover Buttons</span>
      <span class="setting-hint">When a row is On, action buttons appear on hover. When Off, the buttons stay permanently visible.</span>
    </div>
    {#each hoverButtonControls as ctl (ctl.key)}
      <div class="setting-row">
        <label class="setting-label sublabel" for={`hover-${ctl.key}`}>{ctl.label}</label>
        <button
          id={`hover-${ctl.key}`}
          class="toggle-btn"
          class:active={hoverButtonValue(ctl.key)}
          onclick={() => toggleHoverButton(ctl.key)}
          role="switch"
          aria-checked={hoverButtonValue(ctl.key)}
          aria-label={`Hover buttons for ${ctl.label}`}
        >
          <span class="toggle-track">
            <span class="toggle-thumb"></span>
          </span>
          <span class="toggle-label">{hoverButtonValue(ctl.key) ? 'On' : 'Off'}</span>
        </button>
      </div>
    {/each}
  </div>
</div>

<style>
  .general-settings {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .auto-save-hint {
    margin: 0 0 8px;
    font-size: 11px;
    color: var(--text-tertiary);
    font-style: italic;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 36px;
  }

  .setting-label {
    font-size: var(--font-size-base);
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .setting-label.sublabel {
    padding-left: 12px;
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .setting-label-stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }

  .setting-hint {
    font-size: 11px;
    color: var(--text-tertiary);
    line-height: 1.5;
  }

  .setting-select {
    padding: 6px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
    cursor: pointer;
    min-width: 140px;
  }

  .setting-select:focus {
    border-color: var(--ui-border-focus);
  }
  .setting-select:focus:not(:focus-visible) {
    outline: none;
  }

  .setting-input {
    padding: 6px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-bg);
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-family: var(--font-system);
  }

  .setting-input:focus {
    border-color: var(--ui-border-focus);
  }
  .setting-input:focus:not(:focus-visible) {
    outline: none;
  }

  .number-input {
    width: 80px;
    text-align: center;
  }

  .setting-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .font-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .font-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--ui-border);
    border-radius: 16px;
    background: var(--ui-surface);
    font-size: 12px;
    color: var(--text-primary);
  }

  .chip-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: color 0.1s ease, background-color 0.1s ease;
    padding: 0;
  }

  .chip-remove:hover:not(:disabled) {
    background: var(--ui-surface-hover);
    color: var(--accent-danger);
  }

  .chip-remove:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .btn-secondary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    background: var(--ui-surface);
    color: var(--text-secondary);
    font-size: 12px;
    font-family: var(--font-system);
    cursor: pointer;
    transition: background-color 0.1s ease, color 0.1s ease;
    align-self: flex-start;
  }

  .btn-secondary:hover {
    background: var(--ui-surface-hover);
    color: var(--text-primary);
  }

  .setting-divider {
    height: 1px;
    background: var(--ui-border);
    margin: 4px 0;
  }

  .apply-defaults-row {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    margin-top: 4px;
  }
  .setting-helper {
    margin: 0;
    color: var(--text-tertiary);
    font-size: 11px;
    line-height: 1.4;
  }
  .apply-defaults-btn {
    align-self: flex-start;
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

  .scale-row {
    align-items: center;
  }

  .scale-control {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
  }

  .scale-slider {
    width: 160px;
    accent-color: var(--accent-primary);
  }

  .scale-badge {
    display: inline-block;
    min-width: 44px;
    padding: 2px 6px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: 4px;
    text-align: center;
  }
</style>
