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

<h4 class="subsection-title">Board</h4>
<div class="setting-row">
  <label class="setting-label" for="cb-tl-title-fs">Board Title Font Size</label>
  <input
    id="cb-tl-title-fs"
    class="setting-input number-input"
    type="number"
    min="8"
    max="48"
    placeholder="Default"
    value={(read('titleFontSize') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('titleFontSize', e.currentTarget)}
  />
</div>

<h4 class="subsection-title">Accent</h4>
<div class="setting-row">
  <span class="setting-label">Accent Color</span>
  <ColorPicker
    value={(read('accentColor') as string) ?? ''}
    onchange={(c) => update('accentColor', c)}
  />
</div>

<h4 class="subsection-title">Section Overrides</h4>
<div class="setting-row">
  <span class="setting-label">Header Color</span>
  <ColorPicker
    value={(read('defaults.section.headerColor') as string) ?? ''}
    onchange={(c) => update('defaults.section.headerColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Body Color</span>
  <ColorPicker
    value={(read('defaults.section.bodyColor') as string) ?? ''}
    onchange={(c) => update('defaults.section.bodyColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Border Color</span>
  <ColorPicker
    value={(read('defaults.section.borderColor') as string) ?? ''}
    onchange={(c) => update('defaults.section.borderColor', c)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-section-border-style">Border Style</label>
  <select
    id="cb-section-border-style"
    class="setting-select"
    value={(read('defaults.section.borderStyle') as string) ?? ''}
    onchange={(e) => update('defaults.section.borderStyle', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each BORDER_STYLE_OPTIONS as b (b)}
      <option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-section-border-width">Border Width</label>
  <input
    id="cb-section-border-width"
    class="setting-input number-input"
    type="number"
    min="0"
    max="10"
    placeholder="Inherit"
    value={(read('defaults.section.borderWidth') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.section.borderWidth', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-section-shadow">Shadow Intensity</label>
  <input
    id="cb-section-shadow"
    class="setting-input number-input"
    type="number"
    min="0"
    max="1"
    step="0.05"
    placeholder="Inherit"
    value={(read('defaults.section.shadowIntensity') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.section.shadowIntensity', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-section-dct">Dynamic Contrast Text</label>
  <select
    id="cb-section-dct"
    class="setting-select"
    value={formatBoolean(read('defaults.section.dynamicContrastText'))}
    onchange={(e) => update('defaults.section.dynamicContrastText', parseBoolean((e.target as HTMLSelectElement).value))}
  >
    <option value="">— Inherit —</option>
    <option value="true">On</option>
    <option value="false">Off</option>
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-section-fs-title">Title Font Size</label>
  <input
    id="cb-section-fs-title"
    class="setting-input number-input"
    type="number"
    min="8"
    max="48"
    placeholder="Inherit"
    value={(read('defaults.section.fontSizeTitle') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.section.fontSizeTitle', e.currentTarget)}
  />
</div>

<h4 class="subsection-title">Task Overrides</h4>
<div class="setting-row">
  <span class="setting-label">Body Color</span>
  <ColorPicker
    value={(read('defaults.task.bodyColor') as string) ?? ''}
    onchange={(c) => update('defaults.task.bodyColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Border Color</span>
  <ColorPicker
    value={(read('defaults.task.borderColor') as string) ?? ''}
    onchange={(c) => update('defaults.task.borderColor', c)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-task-border-style">Border Style</label>
  <select
    id="cb-task-border-style"
    class="setting-select"
    value={(read('defaults.task.borderStyle') as string) ?? ''}
    onchange={(e) => update('defaults.task.borderStyle', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each BORDER_STYLE_OPTIONS as b (b)}
      <option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-task-border-width">Border Width</label>
  <input
    id="cb-task-border-width"
    class="setting-input number-input"
    type="number"
    min="0"
    max="10"
    placeholder="Inherit"
    value={(read('defaults.task.borderWidth') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.task.borderWidth', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-task-shadow">Shadow Intensity</label>
  <input
    id="cb-task-shadow"
    class="setting-input number-input"
    type="number"
    min="0"
    max="1"
    step="0.05"
    placeholder="Inherit"
    value={(read('defaults.task.shadowIntensity') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.task.shadowIntensity', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-task-dct">Dynamic Contrast Text</label>
  <select
    id="cb-task-dct"
    class="setting-select"
    value={formatBoolean(read('defaults.task.dynamicContrastText'))}
    onchange={(e) => update('defaults.task.dynamicContrastText', parseBoolean((e.target as HTMLSelectElement).value))}
  >
    <option value="">— Inherit —</option>
    <option value="true">On</option>
    <option value="false">Off</option>
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-task-fs-title">Title Font Size</label>
  <input
    id="cb-task-fs-title"
    class="setting-input number-input"
    type="number"
    min="8"
    max="48"
    placeholder="Inherit"
    value={(read('defaults.task.fontSizeTitle') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.task.fontSizeTitle', e.currentTarget)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-task-fs-body">Body Font Size</label>
  <input
    id="cb-task-fs-body"
    class="setting-input number-input"
    type="number"
    min="8"
    max="48"
    placeholder="Inherit"
    value={(read('defaults.task.fontSizeBody') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.task.fontSizeBody', e.currentTarget)}
  />
</div>
