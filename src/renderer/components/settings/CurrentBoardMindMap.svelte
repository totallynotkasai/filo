<script lang="ts">
  /**
   * Per-board overrides for Mind Map boards. Reads/writes through
   * pendingSettingsStore.updateBoard so the modal's Apply/Cancel still
   * govern commit behaviour.
   */
  import { pendingSettingsStore } from '../../stores/pendingSettings.svelte';
  import ColorPicker from '../shared/ColorPicker.svelte';
  import BackgroundImagePicker from '../shared/BackgroundImagePicker.svelte';
  import {
    SHAPE_OPTIONS,
    BORDER_STYLE_OPTIONS,
    PATH_TYPE_OPTIONS,
    ARROW_TYPE_OPTIONS,
  } from '../../constants/styleOptions';
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

<h4 class="subsection-title">Tile Overrides</h4>
<div class="setting-row">
  <span class="setting-label">Header Color</span>
  <ColorPicker
    value={(read('defaults.tile.headerColor') as string) ?? ''}
    onchange={(c) => update('defaults.tile.headerColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Body Color</span>
  <ColorPicker
    value={(read('defaults.tile.bodyColor') as string) ?? ''}
    onchange={(c) => update('defaults.tile.bodyColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Border Color</span>
  <ColorPicker
    value={(read('defaults.tile.borderColor') as string) ?? ''}
    onchange={(c) => update('defaults.tile.borderColor', c)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-tile-shape">Shape</label>
  <select
    id="cb-tile-shape"
    class="setting-select"
    value={(read('defaults.tile.shape') as string) ?? ''}
    onchange={(e) => update('defaults.tile.shape', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each SHAPE_OPTIONS as s (s)}
      <option value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-tile-border-style">Border Style</label>
  <select
    id="cb-tile-border-style"
    class="setting-select"
    value={(read('defaults.tile.borderStyle') as string) ?? ''}
    onchange={(e) => update('defaults.tile.borderStyle', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each BORDER_STYLE_OPTIONS as b (b)}
      <option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-tile-border-width">Border Width</label>
  <input
    id="cb-tile-border-width"
    class="setting-input number-input"
    type="number"
    min="0"
    max="10"
    placeholder="Inherit"
    value={(read('defaults.tile.borderWidth') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.tile.borderWidth', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-tile-shadow">Shadow Intensity</label>
  <input
    id="cb-tile-shadow"
    class="setting-input number-input"
    type="number"
    min="0"
    max="1"
    step="0.05"
    placeholder="Inherit"
    value={(read('defaults.tile.shadowIntensity') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.tile.shadowIntensity', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-tile-dct">Dynamic Contrast Text</label>
  <select
    id="cb-tile-dct"
    class="setting-select"
    value={formatBoolean(read('defaults.tile.dynamicContrastText'))}
    onchange={(e) => update('defaults.tile.dynamicContrastText', parseBoolean((e.target as HTMLSelectElement).value))}
  >
    <option value="">— Inherit —</option>
    <option value="true">On</option>
    <option value="false">Off</option>
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-tile-fs-title">Title Font Size</label>
  <input
    id="cb-tile-fs-title"
    class="setting-input number-input"
    type="number"
    min="8"
    max="48"
    placeholder="Inherit"
    value={(read('defaults.tile.fontSizeTitle') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.tile.fontSizeTitle', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-tile-fs-body">Body Font Size</label>
  <input
    id="cb-tile-fs-body"
    class="setting-input number-input"
    type="number"
    min="8"
    max="48"
    placeholder="Inherit"
    value={(read('defaults.tile.fontSizeBody') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.tile.fontSizeBody', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>

<h4 class="subsection-title">Connection Path Overrides</h4>
<div class="setting-row">
  <span class="setting-label">Path Color</span>
  <ColorPicker
    value={(read('defaults.connectionPath.pathColor') as string) ?? ''}
    onchange={(c) => update('defaults.connectionPath.pathColor', c)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-path-size">Path Size</label>
  <input
    id="cb-path-size"
    class="setting-input number-input"
    type="number"
    min="1"
    max="10"
    placeholder="Inherit"
    value={(read('defaults.connectionPath.pathSize') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.connectionPath.pathSize', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-path-type">Path Type</label>
  <select
    id="cb-path-type"
    class="setting-select"
    value={(read('defaults.connectionPath.pathType') as string) ?? ''}
    onchange={(e) => update('defaults.connectionPath.pathType', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each PATH_TYPE_OPTIONS as p (p)}
      <option value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-path-style">Path Style</label>
  <select
    id="cb-path-style"
    class="setting-select"
    value={(read('defaults.connectionPath.pathStyle') as string) ?? ''}
    onchange={(e) => update('defaults.connectionPath.pathStyle', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each BORDER_STYLE_OPTIONS as b (b)}
      <option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-arrow-type">Arrow Type</label>
  <select
    id="cb-arrow-type"
    class="setting-select"
    value={(read('defaults.connectionPath.arrowType') as string) ?? ''}
    onchange={(e) => update('defaults.connectionPath.arrowType', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each ARROW_TYPE_OPTIONS as a (a)}
      <option value={a}>{a.charAt(0).toUpperCase() + a.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <span class="setting-label">Arrow Color</span>
  <ColorPicker
    value={(read('defaults.connectionPath.arrowColor') as string) ?? ''}
    onchange={(c) => update('defaults.connectionPath.arrowColor', c)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-arrow-size">Arrow Size</label>
  <input
    id="cb-arrow-size"
    class="setting-input number-input"
    type="number"
    min="4"
    max="24"
    placeholder="Inherit"
    value={(read('defaults.connectionPath.arrowSize') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.connectionPath.arrowSize', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>

<h4 class="subsection-title">Connection Label Overrides</h4>
<div class="setting-row">
  <span class="setting-label">Text Color</span>
  <ColorPicker
    value={(read('defaults.connectionLabel.textColor') as string) ?? ''}
    onchange={(c) => update('defaults.connectionLabel.textColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Label Background</span>
  <ColorPicker
    value={(read('defaults.connectionLabel.backgroundColor') as string) ?? ''}
    onchange={(c) => update('defaults.connectionLabel.backgroundColor', c)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-label-font-size">Font Size</label>
  <input
    id="cb-label-font-size"
    class="setting-input number-input"
    type="number"
    min="8"
    max="32"
    placeholder="Inherit"
    value={(read('defaults.connectionLabel.fontSize') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.connectionLabel.fontSize', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>

<h4 class="subsection-title">Frame Overrides</h4>
<div class="setting-row">
  <span class="setting-label">Header Color</span>
  <ColorPicker
    value={(read('defaults.frame.headerColor') as string) ?? ''}
    onchange={(c) => update('defaults.frame.headerColor', c)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Body Color</span>
  <ColorPicker
    value={(read('defaults.frame.bodyColor') as string) ?? ''}
    onchange={(c) => update('defaults.frame.bodyColor', c)}
  />
</div>
<div class="setting-row bg-image-row">
  <span class="setting-label">Background Image</span>
  <BackgroundImagePicker
    value={(read('defaults.frame.backgroundImage') as string | undefined) ?? ''}
    onChange={(v) => update('defaults.frame.backgroundImage', v === '' ? undefined : v)}
    title="Choose Default Frame Background Image"
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-frame-opacity">Opacity</label>
  <input
    id="cb-frame-opacity"
    class="setting-input number-input"
    type="number"
    min="0"
    max="1"
    step="0.05"
    placeholder="Inherit"
    value={(read('defaults.frame.backgroundOpacity') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.frame.backgroundOpacity', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>
<div class="setting-row">
  <span class="setting-label">Border Color</span>
  <ColorPicker
    value={(read('defaults.frame.borderColor') as string) ?? ''}
    onchange={(c) => update('defaults.frame.borderColor', c)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-frame-border-style">Border Style</label>
  <select
    id="cb-frame-border-style"
    class="setting-select"
    value={(read('defaults.frame.borderStyle') as string) ?? ''}
    onchange={(e) => update('defaults.frame.borderStyle', (e.target as HTMLSelectElement).value || undefined)}
  >
    <option value="">— Inherit —</option>
    {#each BORDER_STYLE_OPTIONS as b (b)}
      <option value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
    {/each}
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-frame-border-width">Border Width</label>
  <input
    id="cb-frame-border-width"
    class="setting-input number-input"
    type="number"
    min="0"
    max="10"
    placeholder="Inherit"
    value={(read('defaults.frame.borderWidth') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.frame.borderWidth', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-frame-shadow">Shadow Intensity</label>
  <input
    id="cb-frame-shadow"
    class="setting-input number-input"
    type="number"
    min="0"
    max="1"
    step="0.05"
    placeholder="Inherit"
    value={(read('defaults.frame.shadowIntensity') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.frame.shadowIntensity', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-frame-dct">Dynamic Contrast Text</label>
  <select
    id="cb-frame-dct"
    class="setting-select"
    value={formatBoolean(read('defaults.frame.dynamicContrastText'))}
    onchange={(e) => update('defaults.frame.dynamicContrastText', parseBoolean((e.target as HTMLSelectElement).value))}
  >
    <option value="">— Inherit —</option>
    <option value="true">On</option>
    <option value="false">Off</option>
  </select>
</div>
<div class="setting-row">
  <label class="setting-label" for="cb-frame-fs-title">Title Font Size</label>
  <input
    id="cb-frame-fs-title"
    class="setting-input number-input"
    type="number"
    min="8"
    max="48"
    placeholder="Inherit"
    value={(read('defaults.frame.fontSizeTitle') as number | undefined) ?? ''}
    onchange={(e) => updateNumberOrInherit('defaults.frame.fontSizeTitle', (e.target as HTMLInputElement).value, parseFloat)}
  />
</div>

<h4 class="subsection-title">Creation Defaults</h4>
<div class="setting-row">
  <label class="setting-label" for="cb-label-text">Default Label Text</label>
  <input
    id="cb-label-text"
    class="setting-input"
    type="text"
    placeholder="Inherit"
    value={(read('defaults.connectionLabel.defaultText') as string | undefined) ?? ''}
    onchange={(e) => {
      const v = (e.target as HTMLInputElement).value;
      update('defaults.connectionLabel.defaultText', v === '' ? undefined : v);
    }}
  />
</div>
