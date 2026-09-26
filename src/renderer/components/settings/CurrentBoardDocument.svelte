<script lang="ts">
  import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import { BORDER_STYLE_OPTIONS } from '../../constants/styleOptions';
  import {
    readPath,
    updatePath as update,
    formatBoolean,
    parseBoolean,
    updateNumberOrInherit,
  } from '../../lib/settings/currentBoardHelpers';

  let settings = $derived(pendingSettingsStore.effectiveBoardSettings);
  const read = (path: string): unknown => readPath(settings, path);
</script>

<h4 class="subsection-title">Accent</h4>
<div class="setting-row">
  <span class="setting-label">Accent Color</span>
  <ColorPicker
    value={(read('accentColor') as string) ?? ''}
    onchange={(c) => update('accentColor', c)}
  />
</div>

<h4 class="subsection-title">Document Element Overrides</h4>
<div class="setting-row">
  <span class="setting-label">Body Color</span>
  <ColorPicker
    value={(read('defaults.document.bodyColor') as string) ?? ''}
    onchange={(c) => update('defaults.document.bodyColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Border Color</span>
  <ColorPicker
    value={(read('defaults.document.borderColor') as string) ?? ''}
    onchange={(c) => update('defaults.document.borderColor', c)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-doc-border-style">Border Style</label>
  <select
    id="cb-doc-border-style"
    class="setting-select"
    value={(read('defaults.document.borderStyle') as string) ?? ''}
    onchange={(e) => update('defaults.document.borderStyle', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each BORDER_STYLE_OPTIONS as b (b)}
      <option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-doc-border-width">Border Width</label>
  <input
    id="cb-doc-border-width"
    class="setting-input number-input"
    type="number"
    min="0"
    max="10"
    placeholder="Inherit"
    value={(read('defaults.document.borderWidth') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.document.borderWidth', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-doc-shadow">Shadow Intensity</label>
  <input
    id="cb-doc-shadow"
    class="setting-input number-input"
    type="number"
    min="0"
    max="1"
    step="0.05"
    placeholder="Inherit"
    value={(read('defaults.document.shadowIntensity') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.document.shadowIntensity', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-doc-dct">Dynamic Contrast Text</label>
  <select
    id="cb-doc-dct"
    class="setting-select"
    value={formatBoolean(read('defaults.document.dynamicContrastText'))}
    onchange={(e) => update('defaults.document.dynamicContrastText', parseBoolean((e.target as HTMLSelectElement).value))}
  >
    <option value="">— Inherit —</option>
    <option value="true">On</option>
    <option value="false">Off</option>
  </select>
</div>
