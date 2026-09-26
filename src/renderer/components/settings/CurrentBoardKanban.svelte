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

<h4 class="subsection-title">Column Overrides</h4>
<div class="setting-row">
  <span class="setting-label">Header Color</span>
  <ColorPicker
    value={(read('defaults.column.headerColor') as string) ?? ''}
    onchange={(c) => update('defaults.column.headerColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Body Color</span>
  <ColorPicker
    value={(read('defaults.column.bodyColor') as string) ?? ''}
    onchange={(c) => update('defaults.column.bodyColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Border Color</span>
  <ColorPicker
    value={(read('defaults.column.borderColor') as string) ?? ''}
    onchange={(c) => update('defaults.column.borderColor', c)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-column-border-style">Border Style</label>
  <select
    id="cb-column-border-style"
    class="setting-select"
    value={(read('defaults.column.borderStyle') as string) ?? ''}
    onchange={(e) => update('defaults.column.borderStyle', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each BORDER_STYLE_OPTIONS as b (b)}
      <option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-column-border-width">Border Width</label>
  <input
    id="cb-column-border-width"
    class="setting-input number-input"
    type="number"
    min="0"
    max="10"
    placeholder="Inherit"
    value={(read('defaults.column.borderWidth') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.column.borderWidth', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-column-shadow">Shadow Intensity</label>
  <input
    id="cb-column-shadow"
    class="setting-input number-input"
    type="number"
    min="0"
    max="1"
    step="0.05"
    placeholder="Inherit"
    value={(read('defaults.column.shadowIntensity') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.column.shadowIntensity', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-column-dct">Dynamic Contrast Text</label>
  <select
    id="cb-column-dct"
    class="setting-select"
    value={formatBoolean(read('defaults.column.dynamicContrastText'))}
    onchange={(e) => update('defaults.column.dynamicContrastText', parseBoolean((e.target as HTMLSelectElement).value))}
  >
    <option value="">— Inherit —</option>
    <option value="true">On</option>
    <option value="false">Off</option>
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-column-width">Column Width (px)</label>
  <input
    id="cb-column-width"
    class="setting-input number-input"
    type="number"
    min="120"
    max="2000"
    step="10"
    placeholder="Inherit"
    value={(read('defaults.column.width') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.column.width', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-column-fs-title">Title Font Size</label>
  <input
    id="cb-column-fs-title"
    class="setting-input number-input"
    type="number"
    min="8"
    max="48"
    placeholder="Inherit"
    value={(read('defaults.column.fontSizeTitle') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.column.fontSizeTitle', e.currentTarget)}
  />
</div>

<h4 class="subsection-title">Card Overrides</h4>
<div class="setting-row">
  <span class="setting-label">Background Color</span>
  <ColorPicker
    value={(read('defaults.card.backgroundColor') as string) ?? ''}
    onchange={(c) => update('defaults.card.backgroundColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Border Color</span>
  <ColorPicker
    value={(read('defaults.card.borderColor') as string) ?? ''}
    onchange={(c) => update('defaults.card.borderColor', c)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-card-border-style">Border Style</label>
  <select
    id="cb-card-border-style"
    class="setting-select"
    value={(read('defaults.card.borderStyle') as string) ?? ''}
    onchange={(e) => update('defaults.card.borderStyle', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each BORDER_STYLE_OPTIONS as b (b)}
      <option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-card-border-width">Border Width</label>
  <input
    id="cb-card-border-width"
    class="setting-input number-input"
    type="number"
    min="0"
    max="10"
    placeholder="Inherit"
    value={(read('defaults.card.borderWidth') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.card.borderWidth', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-card-shadow">Shadow Intensity</label>
  <input
    id="cb-card-shadow"
    class="setting-input number-input"
    type="number"
    min="0"
    max="1"
    step="0.05"
    placeholder="Inherit"
    value={(read('defaults.card.shadowIntensity') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.card.shadowIntensity', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-card-dct">Dynamic Contrast Text</label>
  <select
    id="cb-card-dct"
    class="setting-select"
    value={formatBoolean(read('defaults.card.dynamicContrastText'))}
    onchange={(e) => update('defaults.card.dynamicContrastText', parseBoolean((e.target as HTMLSelectElement).value))}
  >
    <option value="">— Inherit —</option>
    <option value="true">On</option>
    <option value="false">Off</option>
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-card-fs-title">Title Font Size</label>
  <input
    id="cb-card-fs-title"
    class="setting-input number-input"
    type="number"
    min="8"
    max="48"
    placeholder="Inherit"
    value={(read('defaults.card.fontSizeTitle') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.card.fontSizeTitle', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-card-fs-body">Body Font Size</label>
  <input
    id="cb-card-fs-body"
    class="setting-input number-input"
    type="number"
    min="8"
    max="48"
    placeholder="Inherit"
    value={(read('defaults.card.fontSizeBody') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.card.fontSizeBody', e.currentTarget)}
  />
</div>
